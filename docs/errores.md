# Errores

Por qué un pedido no se carga o una consulta falla. Para cada caso: qué significa y qué hacer.

← [Volver al inicio](../README.md)

Los errores aparecen en dos lugares, según el momento en que ocurren:

- **Al recibir el pedido o la consulta**, en la respuesta HTTP. El pedido ni siquiera entra a la cola.
- **Al cargar el pedido**, que pasa después y en segundo plano. Ahí quien mandó el pedido ya recibió un `202`: el error solo se ve en el panel de la cola (`/admin/queues`) y en los logs del servicio.

Los mensajes están en inglés tal como los devuelve el servicio, para poder buscarlos.

**Contenido**

- [Los más frecuentes](#los-más-frecuentes)
- [Al recibir un pedido](#al-recibir-un-pedido)
- [Al cargar un pedido](#al-cargar-un-pedido)
- [En las consultas](#en-las-consultas)
- [En la escritura genérica](#en-la-escritura-genérica)
- [Cuáles se reintentan solos](#cuáles-se-reintentan-solos)

---

## Los más frecuentes

| Mensaje | En una línea | Qué hacer |
|---|---|---|
| `No sheet row was found with NROVENTA="…"` | Se pidió actualizar una venta que no está en la planilla. | Revisar el número de venta. Si la venta es nueva, tiene que llegar con su `Identificador`. |
| `Planilla Control API failed with …` | La planilla se escribió, pero Madre rechazó la copia. | Ver el código y el detalle que siguen al mensaje. |
| `Column "…" was not found in the sheet headers.` | Falta o se renombró una columna clave. | Restaurar el encabezado exacto en la planilla. |
| `Internal server error` | Google no respondió o no dio acceso. | Ver [errores de Google](#errores-de-google). |
| `… row was not found for …` | La consulta no encontró ese TLQV. | Revisar el código y, en Stock BUE, que no haya [filas vacías en el medio](funcional.md#stock-bue). |

---

## Al recibir un pedido

`POST /sheet/orders`. La respuesta tiene esta forma:

```json
{ "statusCode": 400, "message": "…", "error": "Bad Request" }
```

| Código | Mensaje | Qué significa | Qué hacer |
|---|---|---|---|
| `400` | `Identificador or NROVENTA is required to process an order.` | El pedido no trae `Identificador` ni `NROVENTA`, o los dos vienen vacíos. | Mandar al menos uno. |

Ningún otro dato se controla al recibir: un pedido con un TLQV que no existe, un número de venta inexistente o columnas mal escritas entra igual a la cola, y el problema aparece al cargarlo.

---

## Al cargar un pedido

Se ven en Bull Board, en la cola `sheet-order-writes`, y en los logs con este formato:

```
Sheet order job failed jobId=123 selector=NROVENTA=2000016621010338: <mensaje>
```

### Venta inexistente

```
No sheet row was found with NROVENTA="2000016621010338".
```

El pedido llegó solo con número de venta y ninguna fila de la planilla tiene ese `NROVENTA`. Por esta vía el servicio no crea filas.

**No se reintenta.** Qué hacer: confirmar el número de venta en la planilla. Si es una venta nueva, tiene que cargarse con su `Identificador`.

### Venta sin TLQV

```
The row with NROVENTA="2000016621010338" has no Identificador.
```

La fila con ese número de venta existe pero tiene la columna `Identificador` vacía. El servicio necesita el TLQV para decidir las [protecciones de pedidos históricos](funcional.md#pedidos-históricos) y para la copia en Madre.

**Se reintenta**, aunque no se va a resolver solo. Qué hacer: completar el `Identificador` de esa fila y volver a mandar el pedido.

### Madre rechazó la copia

```
Planilla Control API failed with 401: …
```

La planilla ya quedó escrita, pero Madre respondió con error al copiar el pedido. El número es el código de Madre y lo que sigue, su respuesta.

| Código de Madre | Causa probable |
|---|---|
| `401` · `403` | Falta o es incorrecta la clave interna de Madre en el servidor. |
| `400` · `422` | Madre no acepta algún campo del pedido. El detalle lo dice. |
| `5xx` | Madre tiene un problema. |

Si Madre no contesta en 30 segundos el mensaje es `This operation was aborted`; si no se puede conectar, `fetch failed`.

**Se reintenta.** Cada reintento vuelve a escribir la planilla con los mismos valores. Si se agotan los intentos, la planilla queda actualizada y Madre no.

### Columna clave inexistente

```
Column "Identificador" was not found in the sheet headers.
```

La planilla no tiene una columna con ese encabezado exacto. Pasa cuando alguien renombra la columna `Identificador` o `NROVENTA`, o cuando el pedido trae un `sheetName` que apunta a otra solapa.

**Se reintenta.** Qué hacer: restaurar el encabezado. El servicio guarda los encabezados durante 5 minutos, así que el cambio puede tardar eso en tomarse (ver [cachés](tecnico.md#cachés)).

### Planilla sin encabezados

```
The sheet must have headers in the first row before using this endpoint.
```

La primera fila de la solapa está vacía. **Se reintenta.**

### Errores de Google

Cualquier problema con Google llega con el mensaje que devuelve Google. Los más comunes:

| Mensaje | Causa |
|---|---|
| `The caller does not have permission` | La cuenta de servicio no tiene acceso de edición a la planilla. |
| `Unable to parse range: …` | La solapa no existe: se renombró, o el pedido trajo un `sheetName` equivocado. |
| `Requested entity was not found.` | El ID de la planilla es incorrecto. |
| `Quota exceeded …` | Se superó el límite de Google. El servicio ya reintenta cada llamada antes de dar el error. |

**Se reintentan.**

---

## En las consultas

Endpoints de lectura: `/sheet/prueba-lectura`, `/sheet/stock-bue`, `/sheet/costos-operaciones` y `GET /sheet/orders/{identificador}`.

| Código | Mensaje | Qué significa |
|---|---|---|
| `400` | `page must be a positive integer.` · `pageSize must be a positive integer.` | Página o tamaño de página no es un entero mayor que cero. |
| `400` | `sheetName must be MADRE or TLQV.` | En la planilla de lectura se pidió otra solapa. |
| `400` | `tlqv is required.` · `id is required.` | El código buscado está en blanco. |
| `404` | `TLQV row was not found for id "…".` · `MADRE row was not found for id "…".` | Ese código no está en la solapa. La búsqueda distingue mayúsculas. |
| `404` | `STOCK BUE row was not found for TLQV "…".` | No está, o está debajo de una [fila vacía](funcional.md#stock-bue). |
| `404` | `Costos Operaciones row was not found for TLQV "…".` | No está en la primera columna. |
| `404` | `Order with Identificador "…" was not found.` | Ese TLQV no está en la planilla de pedidos. |
| `400` | `TLQV sheet must have "TLQV" header.` · `MADRE sheet must have "Identificador" header.` · `STOCK BUE sheet must have a "TLQV" header.` · `Column "Identificador" was not found in the sheet headers.` | Falta la columna por la que se busca. |
| `400` | `… sheet must have headers in the first row.` | La primera fila de la solapa está vacía. |
| `500` | `Internal server error` | Falló la llamada a Google. El detalle queda en los logs; las causas son las mismas que en [errores de Google](#errores-de-google). |

Pedir una página más allá de la última no es un error: responde `200` con `rows` vacío. Un `pageSize` mayor que 500 tampoco: se usa 500.

---

## En la escritura genérica

`POST /sheet/rows/upsert` valida el cuerpo antes de escribir y responde `400` con la lista de problemas:

```json
{
  "statusCode": 400,
  "message": ["keyColumn should not be empty", "data must be an object"],
  "error": "Bad Request"
}
```

| Mensaje | Qué falta |
|---|---|
| `keyColumn should not be empty` · `keyColumn must be a string` | La columna por la que se busca la fila. |
| `keyValue should not be empty` | El valor a buscar. |
| `data must be an object` | Los valores a escribir. |
| `sheetName must be a string` | La solapa vino con otro tipo. |
| `property … should not exist` | Llegó un campo que no es ninguno de los cuatro anteriores. |

Después, al escribir, puede responder `400` con `Column "…" was not found in the sheet headers.` —si `keyColumn` no existe, o si hay que agregar una fila y la solapa no tiene columna `Identificador`— o `500` si falla Google. Esta escritura es inmediata, no pasa por la cola y **no se reintenta**.

---

## Cuáles se reintentan solos

Hay dos niveles de reintento.

**Cada llamada a Google** se reintenta hasta 4 veces si Google responde `429` (límite superado) o `500`, `502`, `503`, `504`, esperando medio segundo, uno y dos segundos. Vale para todo: pedidos, consultas y escritura genérica. Los demás errores de Google (permisos, solapa inexistente) no se reintentan a este nivel.

**Cada pedido de la cola** se reintenta entero hasta 5 veces, esperando 5, 10, 20 y 40 segundos:

| Error | ¿Se reintenta el pedido? |
|---|---|
| Venta inexistente (`No sheet row was found…`) | **No** |
| Venta sin TLQV | Sí |
| Madre rechazó la copia o no respondió | Sí |
| Columna clave inexistente · planilla sin encabezados | Sí |
| Errores de Google | Sí |

Un pedido que agotó sus intentos queda como fallido en Bull Board. Se puede reintentar desde ahí una vez corregida la causa.
