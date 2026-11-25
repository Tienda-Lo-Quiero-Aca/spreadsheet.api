# Arquitectura y configuración

Cómo está armado el código, con qué servicios habla y cómo se configura.

← [Volver al inicio](../README.md)

**Contenido**

1. [Capas del código](#capas-del-código)
2. [Dónde está cada cosa](#dónde-está-cada-cosa)
3. [Integraciones](#integraciones)
4. [La cola de pedidos](#la-cola-de-pedidos)
5. [Reintentos](#reintentos)
6. [Cachés](#cachés)
7. [Variables de entorno](#variables-de-entorno)
8. [Scripts](#scripts)
9. [Tests](#tests)
10. [Limitaciones conocidas](#limitaciones-conocidas)

---

## Capas del código

NestJS 10 con una separación entre `core` (negocio) y `app` (framework y tecnología).

```
src/
├── core/                         Negocio
│   ├── entities/sheet/           Tipos: fila, página de filas, resultado de escritura
│   ├── adapters/repositories/    Interfaces de lo que el negocio necesita de afuera
│   ├── drivers/repositories/     Implementación de la copia en Madre
│   ├── interactor/sheet/         Caso de uso: cargar un pedido
│   └── errors/                   Errores de negocio
├── app/                          NestJS
│   ├── controller/sheet/         Endpoints: validan la entrada y delegan
│   ├── services/sheet/           Envuelven los repositorios para los controllers
│   ├── queue/sheet/              La cola de pedidos (BullMQ)
│   ├── driver/sheet/             Lectura y escritura en Google Sheets
│   ├── driver/docs/              Sitio de documentación
│   └── module/sheet/             Módulo: acá se cablea todo
└── main.ts                       Arranque, Bull Board y sitio de documentación
```

La dirección de las dependencias es hacia adentro: el caso de uso (`ProcessSheetOrderInteractor`) recibe sus repositorios por constructor, como interfaces, y no conoce a NestJS ni a Google. La excepción es el repositorio de Madre, que vive en `core/drivers` pero es un provider de NestJS y lee su configuración con `ConfigService`.

Las lecturas no tienen caso de uso: el controller valida los parámetros y el service llama directo al repositorio.

---

## Dónde está cada cosa

| Necesito cambiar… | Archivo |
|---|---|
| Por Identificador o por número de venta; qué pasa si no existe | `core/interactor/sheet/ProcessSheetOrderInteractor.ts` |
| Qué campos se convierten a número; campos que se ignoran (`modo`) | `app/services/sheet/ProcessSheetOrderService.ts` |
| Columnas protegidas, límite de pedidos históricos (`TLQV-12815`) | `app/driver/sheet/GoogleSheetsRowRepository.ts` |
| Dónde se agrega una fila nueva, cachés, reintentos contra Google al escribir | `app/driver/sheet/GoogleSheetsRowRepository.ts` |
| Cola: intentos, espera, ritmo, qué no se reintenta | `app/queue/sheet/SheetOrderQueue.ts` |
| Copia en Madre | `core/drivers/repositories/madre-api/PlanillaControlRepository.ts` |
| Planilla de lectura (solapas TLQV y MADRE) | `app/controller/sheet/planillaControl/` · `app/driver/sheet/planillaControl/` |
| Stock BUE, incluido el corte en la primera fila vacía | `app/driver/sheet/stockBue/StockBueGoogleSheetsRepository.ts` |
| Costos Operaciones | `app/driver/sheet/costosOperaciones/` |
| Validación de la escritura genérica | `app/controller/sheet/rows/dto/UpsertSheetRow.dto.ts` |
| Bull Board, puerto, validación global | `main.ts` |
| Sitio de documentación: páginas publicadas y menú | `app/driver/docs/docs-site.router.ts` |

**Ojo con los nombres.** Las clases `PlanillaControl*` de `controller`, `services` y `driver/sheet` son la **planilla de lectura** (`/sheet/prueba-lectura`; el endpoint se renombró y las clases no). `PlanillaControlRepository` de `core/drivers` es otra cosa: la **copia en Madre**, cuya tabla se llama `planilla_control`.

---

## Integraciones

| Servicio | Para qué | Qué se llama |
|---|---|---|
| **Google Sheets API v4** | Leer y escribir las planillas | `spreadsheets.values.get` · `spreadsheets.values.batchUpdate` |
| **Madre API** | Copia de los pedidos | `POST /api/internal/planilla-control` · `PATCH /api/internal/planilla-control/{identificador}` |
| **Redis** | La cola de pedidos | BullMQ |

Y quién llama a este servicio:

| Cliente | Qué usa |
|---|---|
| **Flokzu** | `POST /sheet/orders` |
| **Invoice API** (bot de facturación) | `GET /sheet/prueba-lectura/TLQV/{tlqv}` · `GET /sheet/prueba-lectura/MADRE/{tlqv}` · `GET /sheet/stock-bue/{tlqv}` |
| **Script de ventas canceladas** | `POST /sheet/orders` (ver [Scripts](#scripts)) |

### Notas por integración

**Google Sheets.** Una cuenta de servicio, con tres formas de pasar las credenciales (ver [variables](#google)). La planilla de pedidos se abre con permiso de escritura (`spreadsheets`); las de lectura, con `spreadsheets.readonly`. Las escrituras usan `valueInputOption: USER_ENTERED`: Google interpreta cada valor como si se tipeara (fechas, números, fórmulas). Las lecturas usan el formato por defecto, así que los valores llegan como se ven en la planilla. Todas las llamadas tienen 30 segundos de timeout y leen hasta la columna `ZZ`.

Escribir un pedido cuesta pocas llamadas: los encabezados y la columna de búsqueda salen de la [caché](#cachés), y las celdas se escriben en un solo `batchUpdate`, una celda por rango. Las lecturas, en cambio, traen **la solapa entera** (`A:ZZ`) en cada consulta, salvo la búsqueda en Costos Operaciones, que lee solo la columna A y después la fila encontrada.

**Madre API.** Header `x-internal-api-key` con `MADRE_API_INTERNAL_API_KEY`; si la variable no está, el header no se manda. El cuerpo es `{ id, identificador, ...campos del pedido }`, con `id` = `identificador` = TLQV. Fila agregada → `POST`, y si Madre responde `409`, `PATCH`. Fila actualizada → `PATCH`, y si responde `404`, `POST`. Timeout fijo de 30 segundos.

---

## La cola de pedidos

Una cola BullMQ sobre Redis, visible en Bull Board.

| | |
|---|---|
| Nombre | `sheet-order-writes` (trabajos `upsert-sheet-order`) |
| Concurrencia | 1 |
| Ritmo | 1 trabajo cada 1000 ms |
| Intentos | 5, con espera exponencial desde 5 s (5 · 10 · 20 · 40 s) |
| Conserva | Los últimos 1000 completados y 5000 fallidos |

- **La concurrencia en 1 es deliberada.** Dos pedidos nuevos procesados a la vez calcularían la misma fila libre. Subirla rompe esa garantía.
- **Venta inexistente no se reintenta**: `SheetOrderNotFoundError` se convierte en `UnrecoverableError`.
- **El ID de cada trabajo es el autoincremental de BullMQ.** Mandar dos veces el mismo pedido encola dos trabajos; como la carga es por TLQV, el segundo actualiza la misma fila con los mismos valores.
- El worker corre dentro del mismo proceso que la API.

---

## Reintentos

| Operación | Reintenta ante | Cómo |
|---|---|---|
| Cada llamada a Google | `429`, `500`, `502`, `503`, `504` | Hasta 4 intentos, esperando 0,5 · 1 · 2 s. Un timeout o un error sin código HTTP no se reintenta a este nivel. |
| Cada pedido de la cola | Cualquier error, salvo venta inexistente | Hasta 5 intentos (ver [la cola](#la-cola-de-pedidos)). |
| Copia en Madre | — | No tiene reintentos propios: si falla, falla el pedido y lo reintenta la cola. |
| Escritura genérica y consultas | — | Solo los de cada llamada a Google. |

Reintentar un pedido es seguro: vuelve a buscar la fila por TLQV y la escribe con los mismos valores. Un pedido que falló después de agregar su fila la encuentra en el reintento y la actualiza, sin duplicarla.

---

## Cachés

`GoogleSheetsRowRepository` guarda en memoria, por 5 minutos:

| Qué | Clave |
|---|---|
| Los encabezados de cada solapa | Solapa |
| El índice valor → número de fila de cada columna de búsqueda (`Identificador`, `NROVENTA`, o la `keyColumn` de la escritura genérica) | Solapa + columna |

Cuando el servicio agrega una fila, la suma al índice de `Identificador` en el momento.

Es lo que hace rápida la escritura, pero **la caché no se entera de los cambios hechos a mano en la planilla**. Durante hasta 5 minutos después de un cambio:

- **Si se inserta, borra o mueve una columna**, los valores se escriben en la columna que estaba en esa posición antes del cambio.
- **Si se insertan o borran filas**, una actualización puede caer en la fila equivocada.
- **Si alguien agrega a mano una fila debajo del último TLQV**, una fila nueva del servicio puede escribirse encima.

Para que tome un cambio en el momento, hay que reiniciar el servicio. Las lecturas (`prueba-lectura`, `stock-bue`, `costos-operaciones`) no usan caché.

---

## Variables de entorno

El servicio lee `.env` del directorio desde el que arranca. La plantilla está en `.env.example`.

Si falta una variable **obligatoria**, el servicio no arranca.

### Servicio

| Variable | Por defecto | Descripción |
|---|---|---|
| `PORT` | `3000` | |
| `BULL_BOARD_ENABLED` | `false` | Publica Bull Board. |
| `BULL_BOARD_PATH` | `/admin/queues` | |
| `BULL_BOARD_USERNAME` · `BULL_BOARD_PASSWORD` | — | **Obligatorias si `BULL_BOARD_ENABLED` es `true`.** |
| `DOCS_SITE_ENABLED` | `true` | Publica esta documentación como sitio. |
| `DOCS_SITE_PATH` | `/docs` | |
| `DOCS_SITE_USER` · `DOCS_SITE_PASSWORD` | — | Si están las dos, el sitio pide usuario y clave y publica todas las páginas. Sin ellas queda abierto y no publica la de operación. |

Las variables booleanas aceptan `true`, `1`, `yes` o `y`; cualquier otro valor es `false`.

### Google

Se usa la primera forma disponible, en este orden:

| Variable | Descripción |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` | El JSON completo de la cuenta de servicio, en base64. Recomendada para el servidor. |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_PRIVATE_KEY` | Email y clave privada. En la clave, los `\n` escritos se convierten en saltos de línea. |
| `GOOGLE_APPLICATION_CREDENTIALS` | Ruta al archivo JSON. Cómoda en local. |

Para generar el base64: `base64 -i service-account.json`.

### Planillas

| Variable | Por defecto | Descripción |
|---|---|---|
| `GOOGLE_SHEETS_SPREADSHEET_ID` | — **obligatoria** | Planilla de pedidos. |
| `GOOGLE_SHEETS_DEFAULT_SHEET` | `Sheet1` | Solapa de pedidos, cuando el pedido no trae `sheetName`. |
| `PRUEBA_LECTURA_SPREADSHEET_ID` | `PLANILLA_CONTROL_SPREADSHEET_ID`, y si no `1b8qGXC38RE9zTE310ZzI_XZqp1z_XXDqv3Dc1OX6JrY` | Planilla de lectura. |
| `PRUEBA_LECTURA_TLQV_SHEET_NAME` | `TLQV` | Solapa que responde a `/sheet/prueba-lectura/TLQV`. |
| `PRUEBA_LECTURA_MADRE_SHEET_NAME` | `MADRE` | Solapa que responde a `/sheet/prueba-lectura/MADRE`. |
| `STOCK_BUE_SPREADSHEET_ID` | `1MQeZVdIz1Q6PnJewfBBl0Z7DX3w3g6Wzaw7xjf7j9Ag` | |
| `STOCK_BUE_SHEET_NAME` | `STOCK BUE` | |
| `COSTOS_OPERACIONES_SPREADSHEET_ID` | — **obligatoria** | |
| `COSTOS_OPERACIONES_SHEET_NAME` | — **obligatoria** | |

### Madre

| Variable | Por defecto | Descripción |
|---|---|---|
| `MADRE_API_BASE_URL` | `https://api.madre.loquieroaca.com` | |
| `MADRE_API_INTERNAL_API_KEY` | — | Clave interna de Madre. Sin ella el header no se manda y Madre probablemente rechace la copia. |

### Redis

| Variable | Por defecto | Descripción |
|---|---|---|
| `REDIS_URL` | — | Si está, tiene prioridad sobre las demás. |
| `REDIS_HOST` · `REDIS_PORT` | `127.0.0.1` · `6379` | |
| `REDIS_USERNAME` · `REDIS_PASSWORD` | — | |
| `REDIS_TLS` | `false` | |

### Cola de pedidos

| Variable | Por defecto | Descripción |
|---|---|---|
| `SHEET_ORDER_QUEUE_CONCURRENCY` | `1` | No subir: ver [la cola](#la-cola-de-pedidos). |
| `SHEET_ORDER_QUEUE_RATE_LIMIT_MAX` | `1` | Trabajos por ventana. |
| `SHEET_ORDER_QUEUE_RATE_LIMIT_DURATION_MS` | `1000` | Ventana del ritmo. |
| `SHEET_ORDER_QUEUE_ATTEMPTS` | `5` | Intentos por pedido. |
| `SHEET_ORDER_QUEUE_BACKOFF_MS` | `5000` | Primera espera; se duplica en cada intento. |
| `SHEET_ORDER_QUEUE_REMOVE_ON_COMPLETE` | `1000` | Trabajos completados que conserva. |
| `SHEET_ORDER_QUEUE_REMOVE_ON_FAIL` | `5000` | Trabajos fallidos que conserva. |

### Valores fijos

No se configuran; están en el código:

| Valor | Dónde |
|---|---|
| Timeout de Google: 30 s · 4 intentos | Cada repositorio de `app/driver/sheet` |
| Caché de encabezados e índices: 5 min | `GoogleSheetsRowRepository` |
| Timeout de Madre: 30 s | `PlanillaControlRepository` |
| Columnas leídas: hasta `ZZ` | Cada repositorio de `app/driver/sheet` |
| Página: 100 por defecto, 500 como máximo | Repositorios de lectura |

---

## Scripts

### Ventas canceladas en Mercado Libre

`scripts/update-mercadolibre-status-from-csv.mjs`. Qué hace y el formato del archivo están en la [guía funcional](funcional.md#marcar-ventas-canceladas-en-mercado-libre).

```bash
npm run orders:update-ml-status -- --file ventas.csv             # prueba: no manda nada
npm run orders:update-ml-status -- --file ventas.csv --execute   # encola las actualizaciones
```

| Opción | Por defecto | Descripción |
|---|---|---|
| `--execute` | — | Sin esta opción, no manda nada. |
| `--url` | `https://spreadsheet.loquieroaca.com/sheet/orders` | Para apuntar a otro ambiente. |
| `--delay-ms` | `150` | Pausa entre ventas. |

Cada venta se manda con hasta 3 intentos (ante `429`, `5xx` o sin respuesta, esperando 1 y 2 s) y 15 segundos de timeout. Al final muestra cuántas encoló y la lista de las que fallaron; si alguna falló, termina con código 1.

Que una venta se haya encolado no significa que se haya cargado: las que no están en la planilla fallan después, en la cola.

### Vista previa de la documentación

```bash
npm run docs:preview    # http://localhost:4310/docs
```

Levanta solo el sitio de documentación, sin Redis ni Google. El puerto se cambia con `DOCS_PREVIEW_PORT`. Con `DOCS_SITE_USER` y `DOCS_SITE_PASSWORD` definidas, pide credenciales y muestra también la página de operación.

`scripts/` no se compila con el servicio (`tsconfig.build.json` lo excluye), para que el punto de entrada siga siendo `dist/main.js`.

---

## Tests

```bash
npm test             # 2 suites, 11 tests
npm run typecheck
npm run lint
```

Los tests están junto al código (`*.spec.ts`):

- `ProcessSheetOrderInteractor.spec.ts` — la carga de un pedido: por número de venta, que no cambie el `Identificador`, que use el TLQV de la fila para las protecciones y que no agregue filas si la venta no existe; por `Identificador`, que agregue o actualice.
- `docs-site.router.spec.ts` — el sitio de documentación: qué páginas publica con y sin credenciales, y que no sirva nada fuera de la lista.

El acceso a Google (`GoogleSheetsRowRepository` y los repositorios de lectura), la cola, la copia en Madre y los controllers no tienen tests; se verifican a mano.

---

## Limitaciones conocidas

**Los endpoints no tienen autenticación.** Cualquiera que llegue a la URL puede leer las cuatro planillas y escribir en la de pedidos. Si el servicio está protegido, es por fuera de este código.

**La caché no ve los cambios hechos a mano.** Durante hasta 5 minutos después de mover columnas o filas en la planilla de pedidos, el servicio puede escribir en la columna o la fila equivocada. Ver [cachés](#cachés).

**Un TLQV repetido se resuelve por la última fila.** Si el mismo `Identificador` o `NROVENTA` está dos veces, se actualiza la última aparición y la otra queda desactualizada, sin aviso.

**Los valores se interpretan como tipeados.** Un texto que empieza con `=` se carga como fórmula, y un número largo mandado como texto puede quedar como número si la columna no tiene formato de texto.

**Números con separador de miles.** `1.234,56` no se reconoce como número: queda como texto en la planilla y las fórmulas que lo usen fallan.

**Madre recibe lo que la planilla no escribe.** La copia en Madre manda todos los campos del pedido, incluidos los de columnas protegidas y los que no coinciden con ninguna columna.

**Las lecturas traen la solapa entera.** Cada consulta —también la búsqueda de un solo TLQV— lee toda la solapa desde Google, sin caché. En planillas grandes es lento, y cada consulta cuenta para el límite de Google.

**Stock BUE se corta en la primera fila vacía.** Una fila vacía en el medio oculta todo lo que está debajo.

**Un error de Google llega como `500` genérico.** Permisos, solapa inexistente o límite superado responden `Internal server error`; el motivo solo está en los logs.

**Una venta sin TLQV se reintenta igual.** El error `has no Identificador` no se va a resolver solo, pero consume los 5 intentos.

**El servicio no arranca sin la planilla de Costos Operaciones.** `COSTOS_OPERACIONES_SPREADSHEET_ID` y `COSTOS_OPERACIONES_SHEET_NAME` son obligatorias aunque solo las usen dos endpoints de consulta.

**Redis caído.** Las conexiones se crean con `maxRetriesPerRequest: null`, así que mientras Redis no responde, ioredis retiene los comandos en lugar de fallar: un `POST /sheet/orders` puede quedar esperando hasta que Redis vuelva.
