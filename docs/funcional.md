# Guía funcional

Qué hace el servicio con las planillas de la operación, explicado desde el pedido: qué se carga, qué se respeta, dónde termina cada dato y qué se puede consultar.

← [Volver al inicio](../README.md)

**Contenido**

1. [Las planillas](#las-planillas)
2. [Cómo se carga un pedido](#cómo-se-carga-un-pedido)
3. [Qué se escribe y qué no](#qué-se-escribe-y-qué-no)
4. [Columnas protegidas](#columnas-protegidas)
5. [Pedidos históricos](#pedidos-históricos)
6. [Números y textos](#números-y-textos)
7. [Orden y reintentos](#orden-y-reintentos)
8. [Copia en Madre](#copia-en-madre)
9. [Consultas](#consultas)
10. [Marcar ventas canceladas en Mercado Libre](#marcar-ventas-canceladas-en-mercado-libre)

---

## Las planillas

El servicio trabaja con cuatro planillas de Google. Solo en la primera escribe; las otras tres las lee.

| Planilla | Qué hace el servicio | Quién la usa |
|---|---|---|
| **Pedidos** | Agrega y actualiza pedidos (TLQV). | Flokzu, al avanzar cada pedido. |
| **Lectura** — solapas `TLQV` y `MADRE` | Devuelve filas. | El bot de facturación, para leer los importes de cada venta. |
| **Stock BUE** | Devuelve filas. | El bot de facturación, como respaldo cuando la venta no está en la solapa `TLQV`. |
| **Costos Operaciones** | Devuelve filas. | Consultas de costos por operación. |

Cada planilla se identifica por su ID de Google y el nombre de la solapa, que se configuran en el servidor (ver [variables de entorno](tecnico.md#variables-de-entorno)). La cuenta de servicio de Google tiene que tener acceso a cada una: de edición en la de pedidos, de lectura en las demás.

---

## Cómo se carga un pedido

Flokzu manda los datos del pedido con los mismos nombres que las columnas de la planilla (`Identificador`, `ESTADO`, `NROVENTA`, `Cantidad de Unidades`…). El servicio lo pone en una cola, responde enseguida que lo recibió, y lo carga unos instantes después.

Para cargarlo necesita saber de qué pedido se trata, y hay dos formas.

### Por Identificador

Es la forma normal. El pedido trae su código TLQV en `Identificador`.

- **Si el TLQV ya está en la planilla**, actualiza esa fila: solo las columnas que llegaron. El resto de la fila queda como estaba.
- **Si el TLQV no está**, agrega una fila nueva justo debajo del último TLQV de la columna `Identificador`.

### Por número de venta

Cuando el pedido no trae `Identificador` pero sí `NROVENTA` (el número de venta de Mercado Libre), el servicio busca la fila con ese número de venta y la actualiza.

- **Nunca agrega filas por esta vía.** Si no encuentra el número de venta, el pedido falla y no se reintenta.
- No cambia el `Identificador` de la fila.
- Las [protecciones de pedidos históricos](#pedidos-históricos) se deciden por el TLQV de la fila encontrada.

Si el pedido trae los dos datos, manda el `Identificador`.

Si no trae ninguno de los dos, se rechaza en el momento y no entra a la cola.

---

## Qué se escribe y qué no

| Situación | Qué pasa |
|---|---|
| El nombre del campo coincide **exactamente** con el encabezado de una columna | Se escribe en esa columna. Mayúsculas y tildes cuentan. |
| El nombre no coincide con ninguna columna | Se ignora, sin aviso. |
| El campo llega **vacío** | **Se borra** la celda. Mandar un campo vacío no es lo mismo que no mandarlo. |
| La columna está [protegida](#columnas-protegidas) | No se escribe, aunque llegue con valor. |
| El campo `modo` | Se ignora. Es del proceso anterior y se acepta por compatibilidad. |
| El campo `sheetName` | Indica otra solapa de la misma planilla. Si no llega, se usa la solapa configurada. |
| Una lista de valores | Se escribe como texto separado por comas. |

Las celdas se escriben de a una. Las columnas que no llegan no se tocan, así que las fórmulas que la planilla tenga en esa fila se conservan, también en las filas nuevas.

Los valores se cargan **como si alguien los tipeara** en la planilla: `2026/05/28` queda como fecha, y un texto que empieza con `=` queda como fórmula.

### Si el TLQV aparece dos veces

Si el mismo `Identificador` (o `NROVENTA`) está en más de una fila, el servicio usa **la última**.

---

## Columnas protegidas

Estas columnas se calculan en la planilla o las carga el equipo a mano. El servicio no las escribe nunca, ni al actualizar ni al agregar una fila:

- `Id operacion` · `Id operaciones`
- `Traduccion ID` · `Transaccion ID` · `Transacciones ID`
- `Notificacion de Amz`
- `NROGUIAMADRE`
- `ETABUE`
- `ALERTA ETA`
- `Ezeiza`
- `ESTADO BUE`
- `STOCK BUE`
- `CANECLADA EN USA`
- `Demora USA-BA`
- `33`

La comparación no distingue mayúsculas, tildes, espacios ni signos: una columna `Traducción ID` o `ETA BUE` también queda protegida.

`ESTADO MERCADOLIBRE` **no** está protegida: se puede actualizar, y es lo que usa la [carga de ventas canceladas](#marcar-ventas-canceladas-en-mercado-libre).

---

## Pedidos históricos

Para los pedidos hasta **TLQV-12815** inclusive, además se protegen las fechas de tránsito, que en esos pedidos se cargaron a mano:

- `Fecha llegada USA`
- `Fecha Salida Usa`
- `Fecha ingreso Arg`
- `Fecha Salida Arg`

Desde **TLQV-12816** en adelante, esas fechas se escriben normalmente.

---

## Números y textos

Algunos campos se cargan como **número** para que las fórmulas de la planilla puedan operar con ellos. El resto se carga como texto.

| Tipo | Campos |
|---|---|
| Importes | `PRECIOVENTA` · `SALDOML` · `COMISIONML` · `COSTOENVIO` · `Impuestos` · `PRECIOAMAZONUSD` · `APORTE ML` · `CUOTASML` · `COM Vendedor` · `A13VENTA` · `FLETEINTERNACIONALA` · `IIFACTURA` |
| Conceptos de factura | `Productoco` · `Productoco.b` · `DIFACTURA` · `DIFACTURA.B` · `TEFACTURA` · `TEFACTURA.B` · `IVAFACTURA` · `IVAFACTURA.B` · `LAFACTURA` · `LAFACTURA.B` |
| Tipos de cambio | `Tipo de cambio de Automeli` · `TIPODECAMBIOCOMPRA` |
| Pesos y medidas | `PESOPRODUCTO` · `PESOVOLUMENTICO` · `PESOCONFIRMADO` · `VALORXKG` · `LARGOPRODUCTO` · `ANCHOPRODUCTO` · `ALTOPRODUCTO` |
| Cantidades | `Cantidad de Unidades` · `CANTIDAD DE BULTOS` |
| Otros | `28` · `29` · `30` |

**El separador decimal puede ser coma o punto**: `1234,56` y `1234.56` se cargan como el número 1234,56. **No se aceptan separadores de miles**: `1.234,56` no se reconoce como número y se carga como texto tal cual llegó. Un valor que no se puede leer como número se carga como texto.

Los identificadores —`NROVENTA`, `CUITCOMPRADOR`, `CUITENVIO`, `CODIGO POSTAL`— se mandan como texto. Cómo los muestra la planilla depende del formato de la columna.

---

## Orden y reintentos

Los pedidos se cargan **de a uno y como máximo uno por segundo**, en el orden en que llegaron. Es deliberado: Google limita la cantidad de escrituras, y cargar en paralelo arriesga que dos pedidos nuevos caigan en la misma fila.

Si una carga falla, se reintenta hasta **5 veces**, esperando 5, 10, 20 y 40 segundos entre intentos. La excepción es un número de venta que no existe: ese pedido falla en el primer intento, porque reintentar no lo va a encontrar.

Los pedidos fallidos quedan en el panel de la cola (`/admin/queues`) con el motivo. Ver [Errores](errores.md).

---

## Copia en Madre

Después de escribir en la planilla, el servicio copia el pedido en la tabla de control de Madre (`planilla_control`), usando el TLQV como clave:

- Si en la planilla se agregó una fila, **crea** el registro en Madre. Si Madre ya lo tenía, lo actualiza.
- Si en la planilla se actualizó una fila, **actualiza** el registro. Si Madre no lo tenía, lo crea.

Lo que se copia son **los campos que llegaron en el pedido**, no la fila completa de la planilla. Eso incluye los campos de columnas protegidas: la planilla no los escribe, pero Madre sí los recibe.

Si Madre no responde o rechaza el pedido, la carga cuenta como fallida y se reintenta entera. La planilla ya quedó escrita; el reintento la vuelve a escribir con los mismos valores.

Solo la carga de pedidos (`/sheet/orders`) copia en Madre. La escritura genérica (`/sheet/rows/upsert`) no.

---

## Consultas

Todas las consultas devuelven las filas **con el nombre de cada columna y el valor tal como se ve en la planilla**, como texto. Una celda vacía viene como texto vacío. También indican el número de fila en la planilla.

Se pueden pedir de a páginas —100 filas por defecto, hasta 500— o buscar un TLQV puntual.

### Planilla de lectura

Tiene dos solapas, y cada una se busca por una columna distinta:

| Solapa | Se busca por la columna | Ejemplo |
|---|---|---|
| `TLQV` | `TLQV` | `TLQV-1569` |
| `MADRE` | `Identificador` | `TLQV-1569` |

La búsqueda distingue mayúsculas: `tlqv-1569` no encuentra `TLQV-1569`.

Es la planilla de donde el bot de facturación toma los importes de cada venta (solapa `TLQV`) y el número de venta de Mercado Libre (solapa `MADRE`).

### Stock BUE

Se busca por la columna `TLQV`, sin distinguir mayúsculas.

**La lectura se corta en la primera fila vacía.** Una fila cuenta como vacía si todas sus celdas están vacías o muestran un error de fórmula (`#N/A`, `#REF!`, `#VALUE!`…). Lo que haya debajo de esa fila no aparece en las consultas, ni por página ni por TLQV.

### Costos Operaciones

Se busca por la **primera columna** de la solapa (`OPERACIÓN`), sin distinguir mayúsculas.

---

## Marcar ventas canceladas en Mercado Libre

Para cargar de una vez muchas ventas canceladas en Mercado Libre hay un script que lee un archivo CSV y, por cada venta, actualiza `ESTADO MERCADOLIBRE` a `cancelled` buscando la fila por número de venta.

El archivo tiene una venta por línea, sin encabezado:

```
2000016621010338,cancelled
2000016621010339,cancelled
```

- El script **controla todo el archivo antes de mandar nada**: si una línea no tiene dos columnas, si el número de venta no es numérico, si el estado no es `cancelled` o si una venta está repetida, no manda ninguna.
- **Sin `--execute` es una prueba**: muestra cuántas ventas leyó y las primeras diez, sin cambiar nada.
- Las ventas que no están en la planilla fallan en la cola sin crear filas.

Cómo correrlo está en [Arquitectura y configuración](tecnico.md#scripts).
