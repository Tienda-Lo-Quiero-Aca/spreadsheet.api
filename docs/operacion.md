# Operación

Cómo desplegar, cómo verificar que quedó bien, y qué hacer ante los problemas más frecuentes.

← [Volver al inicio](../README.md)

**Contenido**

1. [Dónde corre](#dónde-corre)
2. [Deploy](#deploy)
3. [Verificar que está sano](#verificar-que-está-sano)
4. [Problemas frecuentes](#problemas-frecuentes)
5. [Rotar credenciales](#rotar-credenciales)

---

## Dónde corre

Según `ecosystem.config.cjs`, que está en el repositorio:

| | |
|---|---|
| Directorio | `/opt/spreadsheet.api` |
| Proceso | PM2, con el nombre `spreadsheet-api`, una sola instancia |
| Punto de entrada | `dist/main.js` |
| Puerto | `3000` |
| Configuración | `/opt/spreadsheet.api/.env` |
| Reinicio por memoria | Al superar 512 MB |

Dos detalles que evitan confusiones:

- **PM2 ejecuta el código compilado** (`dist/`), no el fuente. Traer cambios con `git pull` no modifica nada de lo que está corriendo.
- **`NODE_ENV` y `PORT` salen de `ecosystem.config.cjs`** y tienen prioridad sobre el `.env`. El resto de la configuración se lee del `.env` al arrancar, así que cualquier reinicio toma sus cambios.

---

## Deploy

Tres pasos, y **los tres son necesarios**: traer el código, compilar y reiniciar.

```bash
cd /opt/spreadsheet.api && git pull && cp -r dist dist.backup && npm run build && ls -l dist/main.js
```

El `ls` del final tiene que mostrar el archivo con la fecha y hora de ahora. Recién entonces:

```bash
pm2 restart spreadsheet-api && rm -rf dist.backup
```

**Por qué el respaldo.** La compilación escribe sobre `dist/`. Si falla a mitad de camino, puede dejar una mezcla de archivos nuevos y viejos. Con el respaldo se vuelve atrás así:

```bash
rm -rf dist && mv dist.backup dist && pm2 restart spreadsheet-api
```

**Si cambiaron dependencias** (`package.json`), agregar `npm ci` antes de compilar.

**Si el cambio es solo de documentación** (`README.md` o `docs/*.md`), alcanza con `git pull`: el sitio en `/docs` lee los textos del repositorio en cada visita, sin compilar ni reiniciar. La primera vez que se sube el sitio sí hace falta el deploy completo.

**Pedidos en la cola durante el deploy.** La cola vive en Redis, así que los pedidos que llegan mientras el servicio reinicia no se pierden: quedan esperando y se cargan cuando vuelve. Lo que no se recibe es lo que Flokzu mande en los segundos en que el proceso está caído.

### Confirmar que quedó la versión nueva

Buscar en el compilado algo que solo exista en el cambio que se subió:

```bash
grep -rl "TEXTO_DEL_CAMBIO" dist/ | head -1
```

Y que PM2 haya reiniciado de verdad:

```bash
pm2 list
```

La columna `uptime` tiene que mostrar segundos o minutos, no días.

---

## Verificar que está sano

**El proceso está arriba**

```bash
pm2 list
```

**Arrancó sin errores**

```bash
pm2 logs spreadsheet-api --lines 60 --nostream
```

Entre las últimas líneas de arranque tiene que aparecer `Nest application successfully started`. Si en cambio aparece `… is required.`, falta una variable obligatoria (ver [el servicio no arranca](#el-servicio-no-arranca)).

**Llega a Google**

```bash
curl -s "https://spreadsheet.loquieroaca.com/sheet/stock-bue?pageSize=1" | head -c 200; echo
```

Tiene que devolver una página con `rows`. Un `Internal server error` indica un problema con Google: ver los logs.

**La cola**

En `https://spreadsheet.loquieroaca.com/admin/queues` (Bull Board, con usuario y contraseña) se ve qué hay en espera, qué se procesó y qué falló. Desde la terminal, los últimos fallos:

```bash
pm2 logs spreadsheet-api --lines 500 --nostream | grep "Sheet order job failed" | tail -5
```

Cada línea trae el TLQV o número de venta y el motivo. El catálogo está en [Errores](errores.md#al-cargar-un-pedido).

---

## Problemas frecuentes

### Subí un cambio y se sigue comportando igual

Casi siempre faltó compilar o reiniciar. `git pull` solo, o `npm run build` sin `pm2 restart`, no cambian lo que está corriendo. Verificar con `pm2 list` que el `uptime` sea reciente, y repetir el [deploy](#deploy) completo.

### El servicio no arranca

Mirar el error en los logs:

```bash
pm2 logs spreadsheet-api --lines 100 --nostream --err
```

| Mensaje | Causa |
|---|---|
| `GOOGLE_SHEETS_SPREADSHEET_ID is required.` | Falta el ID de la planilla de pedidos. |
| `COSTOS_OPERACIONES_SPREADSHEET_ID is required.` · `COSTOS_OPERACIONES_SHEET_NAME is required.` | Faltan los datos de Costos Operaciones. Son obligatorios aunque solo los usen dos consultas. |
| `BULL_BOARD_USERNAME and BULL_BOARD_PASSWORD are required when BULL_BOARD_ENABLED=true.` | Bull Board está activado sin credenciales. |
| `Unexpected token …` / `… is not valid JSON` | `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` está mal copiado. |

### Los pedidos fallan con "The caller does not have permission"

La cuenta de servicio de Google perdió el acceso a la planilla, o la planilla es nueva.

**Solución:** compartir la planilla con el email de la cuenta de servicio (el `client_email` del JSON), con permiso de **editor** para la de pedidos y de lector para las demás. No hace falta reiniciar. Después, reintentar los pedidos fallidos desde Bull Board.

### Se escribió en la columna o la fila equivocada

Casi seguro alguien movió columnas o filas de la planilla de pedidos en los 5 minutos anteriores. El servicio usa los encabezados y la posición de cada TLQV que leyó antes del cambio (ver [cachés](tecnico.md#cachés)).

**Solución:**

1. Reiniciar el servicio para que relea la planilla: `pm2 restart spreadsheet-api`.
2. Corregir a mano las celdas mal escritas. Los logs dicen qué fila se escribió para cada pedido (`Google Sheets write updated identificador=… row=…`).
3. Reenviar los pedidos afectados.

**Para evitarlo:** al reorganizar la planilla de pedidos, reiniciar el servicio enseguida.

### Madre no recibe los pedidos

**Síntoma:** los pedidos fallan con `Planilla Control API failed with 401` (o `403`).

**Causa:** falta o cambió la clave interna de Madre.

**Solución:** corregir `MADRE_API_INTERNAL_API_KEY` en el `.env` y reiniciar. Los pedidos fallidos se pueden reintentar desde Bull Board: la planilla ya estaba escrita y el reintento la vuelve a escribir igual.

### Flokzu no recibe respuesta o la cola no avanza

**Causa probable:** Redis no responde. Mientras Redis está caído, `POST /sheet/orders` puede quedar esperando sin responder.

**Solución:** revisar Redis (`redis-cli ping` si es local; tiene que responder `PONG`) y, cuando vuelva, revisar Bull Board: los pedidos encolados se procesan solos.

### Una venta no se actualiza por número de venta

Error `No sheet row was found with NROVENTA="…"`. La venta no está en la columna `NROVENTA` de la planilla de pedidos, o la celda tiene el número escrito distinto.

**Solución:** revisar la celda en la planilla. Si la venta es nueva, tiene que llegar con su `Identificador`. Este error no se reintenta solo.

### Google responde "Quota exceeded"

Se superó el límite de lecturas o escrituras de Google. El servicio ya reintenta cada llamada. Si pasa seguido, suele ser por muchas consultas a las planillas de lectura, que traen la solapa entera cada vez.

### El servicio se reinicia solo

PM2 lo reinicia si supera 512 MB de memoria. La columna `↺` de `pm2 list` cuenta los reinicios. Si el número crece rápido, revisar los logs alrededor de cada reinicio:

```bash
pm2 logs spreadsheet-api --lines 200 --nostream --err
```

---

## Rotar credenciales

### Clave de la cuenta de servicio de Google

1. En Google Cloud, en la cuenta de servicio, **crear una clave nueva** (JSON). No borrar todavía la vieja.
2. En la computadora donde se descargó, pasarla a base64 y copiarla:

```bash
base64 -i nueva-clave.json | tr -d '\n' | pbcopy
```

3. En el servidor, cargarla sin que quede en el historial de la terminal:

```bash
read -r -s -p "JSON en base64: " NUEVO && echo
```

4. Guardarla y reiniciar:

```bash
cd /opt/spreadsheet.api && cp .env .env.backup && grep -v '^GOOGLE_SERVICE_ACCOUNT_JSON_BASE64=' .env > .env.tmp && printf 'GOOGLE_SERVICE_ACCOUNT_JSON_BASE64=%s\n' "$NUEVO" >> .env.tmp && mv .env.tmp .env && chmod 600 .env && pm2 restart spreadsheet-api
```

5. Verificar que [llega a Google](#verificar-que-está-sano). Si falla, volver atrás con `cp .env.backup .env && pm2 restart spreadsheet-api`.
6. Cuando esté confirmado: borrar la clave vieja en Google Cloud, el respaldo (`rm .env.backup`, que la conserva) y el JSON descargado.

### Clave interna de Madre

Igual que la anterior, con la variable `MADRE_API_INTERNAL_API_KEY`. Para verificarla, esperar el siguiente pedido de Flokzu y confirmar en los logs que aparece `Madre API write` y no `Planilla Control API failed`.

### Usuario y clave de Bull Board y del sitio

`BULL_BOARD_USERNAME` · `BULL_BOARD_PASSWORD` y `DOCS_SITE_USER` · `DOCS_SITE_PASSWORD`. Se cambian en el `.env` y se toman al reiniciar.
