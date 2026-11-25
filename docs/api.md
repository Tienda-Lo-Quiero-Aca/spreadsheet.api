# Referencia de la API

Todos los endpoints del servicio, agrupados por tema.

← [Volver al inicio](../README.md)

**URL base de producción:** `https://spreadsheet.loquieroaca.com`

**Autenticación:** ninguna. Los endpoints no piden clave ni header.

Los ejemplos usan una variable de entorno para no repetir la URL:

```bash
export SPREADSHEET_API_URL="https://spreadsheet.loquieroaca.com"
```

**Contenido**

| Grupo | Endpoints |
|---|---|
| [Pedidos](#pedidos) | Cargar un pedido · Leer un pedido |
| [Escritura genérica](#escritura-genérica) | Agregar o actualizar una fila |
| [Planilla de lectura](#planilla-de-lectura) | Listar una solapa · Buscar un TLQV |
| [Stock BUE](#stock-bue) | Listar · Buscar un TLQV |
| [Costos Operaciones](#costos-operaciones) | Listar · Buscar un TLQV |
| [Herramientas](#herramientas) | Bull Board · Documentación |

### Convenciones

- **Errores** — tienen la forma `{ "statusCode": 404, "message": "…", "error": "Not Found" }`. `400` si falta o es inválido un parámetro, `404` si no se encontró la fila, `500` si falló Google. El catálogo completo está en [Errores](errores.md).
- **Filas** — toda fila devuelta trae `rowNumber`, el número de fila en la planilla (la de encabezados es la 1), y `data`, un objeto con el encabezado de cada columna y su valor **tal como se ve en la planilla**, como texto. Una celda vacía viene como `""`. Se leen hasta la columna `ZZ`.
- **Paginado** — `page` empieza en `1`. `pageSize` es `100` por defecto y como máximo `500`: un valor mayor se reduce a `500` sin error. Los dos tienen que ser enteros mayores que cero.
- **Rutas con espacios o barras** — el TLQV o identificador va en la ruta; si tiene caracteres especiales, tiene que ir codificado.

---

## Pedidos

### Cargar un pedido

```
POST /sheet/orders
```

Recibe un pedido con el formato que manda Flokzu, lo pone en la cola y responde enseguida. La carga en la planilla de pedidos y la copia en Madre se hacen después, en segundo plano. Cómo se decide qué fila se escribe está en la [guía funcional](funcional.md#cómo-se-carga-un-pedido).

**Body** — `application/x-www-form-urlencoded` (también acepta JSON).

Cada campo es una columna de la planilla, con su encabezado exacto. Además:

| Campo | Obligatorio | Descripción |
|---|---|---|
| `Identificador` | Uno de los dos | TLQV del pedido. Si está en la planilla, actualiza esa fila; si no, agrega una. |
| `NROVENTA` | Uno de los dos | Número de venta de Mercado Libre. Solo se usa para buscar la fila si no llegó `Identificador`, y nunca agrega filas. |
| `sheetName` | No | Solapa donde escribir. Por defecto, la de `GOOGLE_SHEETS_DEFAULT_SHEET`. No se escribe como columna. |
| `modo` | No | Se ignora. |

**Ejemplo — cargar o actualizar por TLQV**

```bash
curl -s -X POST "$SPREADSHEET_API_URL/sheet/orders" \
  --data-urlencode 'Identificador=TLQV-12938' \
  --data-urlencode 'FECHAAMAZON=2026/05/28' \
  --data-urlencode 'FECHACOMPRA=2026/05/27' \
  --data-urlencode 'NROVENTA=2000016621010338' \
  --data-urlencode 'ESTADO=COMPRADA'
```

**Ejemplo — actualizar por número de venta**

```bash
curl -s -X POST "$SPREADSHEET_API_URL/sheet/orders" \
  --data-urlencode 'NROVENTA=2000016621010338' \
  --data-urlencode 'ESTADO MERCADOLIBRE=cancelled'
```

**Respuesta — `202`**

```json
{
  "jobId": "123",
  "status": "queued"
}
```

`202` significa que el pedido **entró a la cola**, no que se cargó. Si después falla, solo se ve en Bull Board y en los logs. `jobId` es el número del trabajo en la cola, para buscarlo en Bull Board.

**Errores**

| Código | Cuándo |
|---|---|
| `400` | No llegó `Identificador` ni `NROVENTA` con valor. |

### Leer un pedido

```
GET /sheet/orders/{identificador}
```

Devuelve la fila de la planilla de pedidos cuyo `Identificador` coincide exactamente (sin distinguir espacios al principio o al final, pero sí mayúsculas). Lee la solapa de `GOOGLE_SHEETS_DEFAULT_SHEET`.

```bash
curl -s "$SPREADSHEET_API_URL/sheet/orders/TLQV-12938"
```

**Respuesta**

```json
{
  "rowNumber": 2,
  "data": {
    "Identificador": "TLQV-12938",
    "ESTADO": "COMPRADA",
    "NROVENTA": "2000016621010338"
  }
}
```

`data` trae todas las columnas de la fila; el ejemplo está recortado.

**Errores**

| Código | Cuándo |
|---|---|
| `404` | `Order with Identificador "…" was not found.` |
| `400` | La solapa no tiene columna `Identificador`. |

---

## Escritura genérica

### Agregar o actualizar una fila

```
POST /sheet/rows/upsert
```

Busca `keyValue` en la columna `keyColumn` de la planilla de pedidos. Si lo encuentra, actualiza esa fila con `data`; si no, agrega una fila nueva.

A diferencia de [cargar un pedido](#cargar-un-pedido):

- **Escribe en el momento**, sin cola, y responde cuando terminó.
- **No copia en Madre.**
- **No se reintenta** si falla (salvo los reintentos de cada llamada a Google).
- No convierte números: los valores van como llegan en el JSON.

Las [columnas protegidas](funcional.md#columnas-protegidas) se respetan igual. La protección de [pedidos históricos](funcional.md#pedidos-históricos) se decide por `keyValue` al actualizar, y por `data.Identificador` al agregar.

**Body** — JSON.

| Campo | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `keyColumn` | string | Sí | Encabezado de la columna donde buscar. |
| `keyValue` | string · number · boolean | Sí | Valor a buscar. |
| `data` | objeto | Sí | Encabezado → valor de cada columna a escribir. |
| `sheetName` | string | No | Solapa. Por defecto, la de `GOOGLE_SHEETS_DEFAULT_SHEET`. |

No acepta otros campos.

```bash
curl -s -X POST "$SPREADSHEET_API_URL/sheet/rows/upsert" \
  -H "Content-Type: application/json" \
  -d '{
    "keyColumn": "Identificador",
    "keyValue": "TLQV-12938",
    "data": { "Identificador": "TLQV-12938", "ESTADO": "ENTREGADA" }
  }'
```

**Respuesta**

```json
{
  "action": "updated",
  "rowNumber": 2
}
```

`action` es `updated` o `inserted`.

**Al agregar una fila**, la ubicación se calcula por la columna `Identificador` (debajo del último TLQV), aunque `keyColumn` sea otra. Una solapa sin columna `Identificador` no admite filas nuevas por esta vía, y conviene incluir el valor de `keyColumn` en `data`: si no, la fila nueva no lo tiene.

**Errores**

| Código | Cuándo |
|---|---|
| `400` | El body no es válido (ver [Errores](errores.md#en-la-escritura-genérica)), o falta la columna `keyColumn` o `Identificador`. |

---

## Planilla de lectura

La planilla que consulta el bot de facturación. Tiene dos solapas: `TLQV` y `MADRE`. El nombre de la solapa en la ruta no distingue mayúsculas.

### Listar una solapa

```
GET /sheet/prueba-lectura/{solapa}?page=1&pageSize=100
```

| Parámetro | Descripción |
|---|---|
| `solapa` | `TLQV` o `MADRE`. |
| `page` · `pageSize` | Ver [convenciones](#convenciones). |

```bash
curl -s "$SPREADSHEET_API_URL/sheet/prueba-lectura/TLQV?page=1&pageSize=100"
```

**Respuesta**

```json
{
  "page": 1,
  "pageSize": 100,
  "sheetName": "TLQV",
  "totalRows": 250,
  "totalPages": 3,
  "hasNextPage": true,
  "hasPreviousPage": false,
  "rows": [
    { "rowNumber": 2, "data": { "TLQV": "TLQV-1569", "Precio final": "…" } }
  ]
}
```

Cada `data` trae todas las columnas de la fila; el ejemplo está recortado. Los importes vienen como texto con el formato de la planilla, no como números.

`totalRows` cuenta todas las filas debajo de los encabezados hasta la última con datos, incluidas las vacías que haya en el medio.

### Buscar un TLQV

```
GET /sheet/prueba-lectura/{solapa}/{id}
```

Busca en la columna `TLQV` de la solapa `TLQV`, o en la columna `Identificador` de la solapa `MADRE`. La coincidencia es exacta y distingue mayúsculas.

```bash
curl -s "$SPREADSHEET_API_URL/sheet/prueba-lectura/TLQV/TLQV-1569"
curl -s "$SPREADSHEET_API_URL/sheet/prueba-lectura/MADRE/TLQV-1569"
```

**Respuesta**

```json
{
  "rowNumber": 1570,
  "data": { "TLQV": "TLQV-1569", "Precio final": "…" }
}
```

**Errores**

| Código | Cuándo |
|---|---|
| `400` | La solapa no es `TLQV` ni `MADRE`. |
| `404` | `TLQV row was not found for id "…".` (o `MADRE …`). |

---

## Stock BUE

La lectura **se corta en la primera fila vacía**: lo que esté debajo no aparece ni en el listado ni en la búsqueda. Ver la [guía funcional](funcional.md#stock-bue).

### Listar

```
GET /sheet/stock-bue?page=1&pageSize=100
```

```bash
curl -s "$SPREADSHEET_API_URL/sheet/stock-bue?page=1&pageSize=100"
```

Responde con la misma forma que la [planilla de lectura](#listar-una-solapa), sin `sheetName`.

### Buscar un TLQV

```
GET /sheet/stock-bue/{tlqv}
```

Busca en la columna `TLQV`, sin distinguir mayúsculas.

```bash
curl -s "$SPREADSHEET_API_URL/sheet/stock-bue/TLQV-15239"
```

Responde `{ "rowNumber": …, "data": { … } }`, o `404` si no está.

---

## Costos Operaciones

### Listar

```
GET /sheet/costos-operaciones?page=1&pageSize=100
```

```bash
curl -s "$SPREADSHEET_API_URL/sheet/costos-operaciones?page=1&pageSize=100"
```

Responde con la misma forma que la [planilla de lectura](#listar-una-solapa), sin `sheetName`.

### Buscar un TLQV

```
GET /sheet/costos-operaciones/{tlqv}
```

Busca en la **primera columna** de la solapa (`OPERACIÓN`), sin distinguir mayúsculas.

```bash
curl -s "$SPREADSHEET_API_URL/sheet/costos-operaciones/TLQV-17767"
```

Responde `{ "rowNumber": …, "data": { … } }`, o `404` si no está.

---

## Herramientas

| Ruta | Qué es | Acceso |
|---|---|---|
| `/admin/queues` | **Bull Board**: la cola `sheet-order-writes`, con los pedidos en espera, procesados y fallidos, y el motivo de cada falla. Desde ahí se puede reintentar un pedido fallido. | Usuario y clave (`BULL_BOARD_USERNAME` · `BULL_BOARD_PASSWORD`). Solo si `BULL_BOARD_ENABLED` es `true`. |
| `/docs` | Esta documentación. | Abierta, o con usuario y clave si se configuraron `DOCS_SITE_USER` y `DOCS_SITE_PASSWORD`. |

El servicio no tiene un endpoint de estado. Para comprobar que responde y llega a Google, alcanza con una consulta liviana:

```bash
curl -s "$SPREADSHEET_API_URL/sheet/stock-bue?pageSize=1"
```
