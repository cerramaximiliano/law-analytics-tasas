# Tasas de Interés — Flujos y Prioridades

## 1. Arquitectura General

El sistema de tasas opera en capas. Cada capa tiene una responsabilidad clara:

```
┌─────────────────────────────────────────────────────────────────┐
│  Scrapers nativos (primario)                                    │
│  BNA Web scraping · BCRA API REST                               │
└───────────────────────────┬─────────────────────────────────────┘
                            │ si quedan gaps históricos
┌───────────────────────────▼─────────────────────────────────────┐
│  CPACF / Consejo (fallback)                                     │
│  tasas.cpacf.org.ar — cubre cualquier rango desde 1991          │
└───────────────────────────┬─────────────────────────────────────┘
                            │ si CPACF tampoco resuelve
┌───────────────────────────▼─────────────────────────────────────┐
│  Edición manual admin                                           │
│  PUT /api/tasas/valor — fuente: "Admin Manual"                  │
└─────────────────────────────────────────────────────────────────┘
```

Los valores se almacenan en la colección **`Tasas`** (MongoDB) como porcentaje de interés **diario** (`tasaActivaBNA`, `tasaPasivaBNA`, etc.). La colección **`TasasConfig`** lleva el seguimiento de cobertura por tipo de tasa.

---

## 2. Fuentes y Prioridades por Tipo de Tasa

| tipoTasa | Fuente primaria | Servicio | Fallback |
|---|---|---|---|
| `tasaActivaBNA` | BNA Web | `bnaService.actualizarTasaEspecifica` | CPACF rateId=1 |
| `tasaActivaTnaBNA` | BNA Web | `bnaService.actualizarTasaEspecifica` | CPACF rateId=25 |
| `tasaActivaCNAT2658` | BNA Web | `bnaService.actualizarTasaEspecifica` | CPACF rateId=22 |
| `tasaActivaCNAT2764` | BNA Web | `bnaService.actualizarTasaEspecifica` | CPACF rateId=23 |
| `tasaPasivaBNA` | CPACF (directo) | — | CPACF rateId=2 |
| `tasaPasivaBCRA` | BCRA API | `bcraService.findMissingDataServiceBcra` (idVar=43) | — |
| `cer` | BCRA API | `bcraService.findMissingDataServiceBcra` (idVar=30) | — |
| `icl` | BCRA API | `bcraService.findMissingDataServiceBcra` (idVar=40) | — |
| `tasaActivaCNAT2601` | Pendiente | rate ID CPACF no verificado | — |

### Capacidad histórica de cada fuente

| Fuente | Datos históricos | Observaciones |
|---|---|---|
| BNA Web scraping | Solo dato del día actual | Publica fechas futuras en fines de semana/feriados |
| BCRA API REST | Cualquier rango desde 2003 | Requiere `idVariable` por tasa |
| CPACF | Cualquier rango desde 1991 | Sesión Puppeteer con credenciales (`DU_01`, `TREG_01`, `FREG_01`) |
| Admin Manual | N/A | Corrección puntual via UI |

---

## 3. Comportamiento de BNA — Carry-Forward

BNA tiene un comportamiento particular: publica la tasa con una **fecha de vigencia futura** (normalmente fines de semana y feriados).

### Ejemplo
Hoy es viernes 7/3. BNA publica tasa con fecha de vigencia 10/3 (lunes).

**Problema:** Los días 8/3 y 9/3 (sábado y domingo) quedan sin dato.

**Solución implementada en `bnaService.procesarVigenciaTasa` + `completarDiasIntermedios`:**

```
esFechaFutura = (fechaVigencia > hoy)  →  true

diasHastaVigencia = [8/3, 9/3]
  (desde fechaUltima+1 hasta fechaVigencia-1)

→ completarDiasIntermedios():
    Para cada fecha intermedia:
      Busca último registro real en Tasas (antes de hoy)
      Copia el valor del último registro conocido
      Guarda en Tasas con origenDato = "completado_automaticamente"
    Luego llama actualizarFechasFaltantes() para limpiar TasasConfig
```

**CPACF también maneja carry-forward** de forma nativa: agrupa períodos con la misma tasa en un único registro (ej: 06/03→08/03 con misma tasa). El scraper expande esos períodos en registros diarios individuales.

---

## 4. Colección TasasConfig — Seguimiento de Cobertura

Cada documento en `TasasConfig` tiene:

| Campo | Descripción |
|---|---|
| `tipoTasa` | Identificador del tipo de tasa |
| `fechaInicio` | Primera fecha con datos en `Tasas` |
| `fechaUltima` | Última fecha registrada (puede ser futura en BNA) |
| `fechaUltimaCompleta` | Último día sin gaps desde `fechaInicio` |
| `fechasFaltantes` | Array de fechas `Date` con datos ausentes |
| `ultimaVerificacion` | Timestamp del último scraping exitoso |

### Lógica de `actualizarConfigTasa`

Se llama cada vez que se guarda un valor en `Tasas`:

```
Si fechasFaltantes no está vacío:
  → Elimina la fecha recién guardada de fechasFaltantes
  → Recalcula fechaUltimaCompleta (día anterior al primer faltante)

Si fechasFaltantes está vacío:
  Si diff(nuevaFecha, fechaUltimaCompleta) <= 1 día:
    → Avanza fechaUltimaCompleta (período continuo)
  Si diff > 1 día:
    → Hay un gap implícito
    → Agrega días intermedios a fechasFaltantes
    → No avanza fechaUltimaCompleta
```

---

## 5. Relleno de Gaps — Gap Filler

### Cuándo se ejecuta

1. **Cron automático**: todos los días a las **3:00 AM** (`cpacfGapFiller.diario = '0 3 * * *'`)
2. **Trigger manual**: botón en la UI admin → `POST /api/tasas/rellenar-gaps[?tipoTasa=...]`

### Flujo de `fillGapsForTasa(tipoTasa)`

```
1. ¿Es tasa BCRA? (tasaPasivaBCRA / cer / icl)
   → findMissingDataServiceBcra(tipoTasa, idVariable)
   → FIN

2. ¿Es tasa BNA/CNAT en CPACF_TASA_MAP?
   a. Si tiene bnaCompatible=true:
      → actualizarTasaEspecifica(tipoTasa)   ← intento nativo
   b. ¿Quedan gaps en TasasConfig?
      → findMissingDataColegio(tipoTasa, rateId)  ← CPACF fallback
   → FIN

3. Tasa no soportada → log y retorna sin ejecutar
```

### Flujo interno de `findMissingDataColegio`

```
1. Lee fechasFaltantes de TasasConfig (solo fechas pasadas o de hoy)
2. Si hay fechasFaltantes → genera rango (min→max) como ventana de consulta
3. Si no hay fechasFaltantes → verifica si fechaUltima < hoy, usa ese rango
4. Llama a main() con las credenciales CPACF y el rateId
5. main() → CPACFScraper:
   a. initialize() + login()
   b. getAvailableRates()
   c. selectRate(rateId)
   d. calcular({ capital, date_from_0, date_to, capitalization? })
   e. extrae detalles (porcentaje_interes_diario, mensual, anual por período)
   f. procesarYGuardarTasas():
      - Por cada período del resultado CPACF:
        - Expande a días individuales
        - Valor = diario ?? mensual/30.4167 ?? anual/365
        - Guarda en Tasas via actualizarTasa()
        - actualizarTasa() llama actualizarConfigTasa() → limpia fechasFaltantes
```

### CPACF — Extracción de tasa diaria por tipo

| Tipo de tabla CPACF | Campos disponibles |
|---|---|
| Modelo 1 (tasaActivaBNA, tasaPasivaBNA) | % Diario ✅ · % Mensual ✅ · % Anual ✅ |
| Modelo 2 (tasaActivaCNAT2764) | % Diario ✅ · % Mensual ❌ · % Anual ✅ |
| Modelo 3 (tasaActivaCNAT2658, tasaActivaTnaBNA) | % Diario ✅ · % Mensual ❌ · % Anual ✅ |

Todas las tasas verificadas tienen `porcentaje_interes_diario` disponible directamente. El fallback mensual/anual es de seguridad.

---

## 6. Crons Registrados

Definidos en `server/config/cronConfig.js` y registrados en `server/services/tasks/taskService.js`:

| Task ID | Expresión | Descripción |
|---|---|---|
| `bna-tasa-activa` | `0 6 * * *` | Scraping diario BNA (tasas activas BNA/CNAT) |
| `bcra-tasa-pasiva` | variable | Scraping tasaPasivaBCRA via BCRA API |
| `cpacf-gap-filler` | `0 3 * * *` | Relleno de gaps — nativo primero, CPACF fallback |
| `verificacion-tasas` | `0 9 * * *` | Verificación y alerta por email si tasas desactualizadas |

---

## 7. API Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/tasas/listado` | Config de todas las tasas activas (incluye fechasFaltantes) |
| `GET` | `/api/tasas/consulta` | Valores por fecha, campo y rango |
| `PUT` | `/api/tasas/valor` | Actualiza un valor puntual (edición manual) |
| `GET` | `/api/tasas/status` | Resumen de tasas actualizadas vs desactualizadas |
| `POST` | `/api/tasas/rellenar-gaps` | Trigger manual del gap filler (`?tipoTasa=` opcional) |

---

## 8. Variables de Entorno Requeridas

| Variable | Uso |
|---|---|
| `DU_01` | DNI para login en CPACF |
| `TREG_01` | Tomo de registro CPACF |
| `FREG_01` | Folio de registro CPACF |

---

## 9. Archivos Clave

| Archivo | Descripción |
|---|---|
| `server/services/scrapers/tasas/cpacfGapFillerService.js` | Orquestador de relleno de gaps con prioridades |
| `server/services/scrapers/tasas/bnaService.js` | Scraping BNA web + carry-forward |
| `server/services/scrapers/tasas/bcraService.js` | BCRA API REST + gap filler histórico |
| `server/services/scrapers/tasas/colegioService.js` | CPACFScraper (Puppeteer) + `findMissingDataColegio` |
| `server/controllers/tasasController.js` | Endpoints REST + `actualizarConfigTasa` |
| `server/controllers/tasasConfigController.js` | `actualizarFechasFaltantes` + `verificarFechasFaltantes` |
| `server/config/cronConfig.js` | Expresiones cron centralizadas |
| `server/services/tasks/taskService.js` | Registro de crons al iniciar el servidor |
| `scripts/testCpacfValues.js` | Diagnóstico: verifica campos extraídos por CPACF por tasa |

---

## 10. Series mensuales — IndicesMensuales

Agregado el 2026-11-23. Describe lo que ya hace el código; no cambia nada.

Además de las tasas diarias de la colección `tasas`, el servicio mantiene series **mensuales** en la colección `indicesmensuales` (un documento por `serie` + `periodo` AAAA-MM).

### 10.1. Series y fuentes

| serie | fuente oficial | tipo | desde | documento en TasasConfig |
|---|---|---|---|---|
| `inflacionMensual` | API del BCRA, variable 27 (IPC INDEC) | `variacion` (% del mes) | 1943-03 | sí |
| `ipc` | datos.gob.ar, serie `148.3_INIVELNAL_DICI_M_26` (INDEC, base dic-2016 = 100) | `nivel` | 2016-12 | sí |
| `ripte` | **Secretaría de Trabajo**, `argentina.gob.ar/trabajo/seguridadsocial/ripte` (últimos ~21 meses, manda); histórico de datos.gob.ar, serie `158.1_REPTE_0_0_5` | `nivel` | 1994-07 | sí |
| `smvm` | datos.gob.ar, serie `57.1_SMVMM_0_M_34` | `valor` | 1988 | no |
| `haberMinimo` | datos.gob.ar, serie `58.1_MP_0_M_24` | `valor` | 1994-01 | no |
| `isal`, `ingr`, `isbicC`, `isbicNC`, `remRes140`, `remRes135`, `remLey27260` | cargas históricas previsionales (haber de caja) | `nivel` | — | no |

Las de tipo `valor` son montos vigentes (topes y pisos): la fuente publica solo los meses con cambio y los intermedios se rellenan con `rellenoDesde`. No se ofrecen como tasa y por eso no tienen documento de configuración.

Código: `server/services/scrapers/tasas/indicesMensualesService.js` (`SERIES_MENSUALES`, `actualizarSerieMensual`, `actualizarTodas`).

### 10.2. Configuración: períodos completos y faltantes

Las series mensuales usables como tasa tienen su documento en `tasasconfigs`, igual que las diarias, con los campos que fija el catálogo `server/utils/tasasIndices.js` (`CATALOGO_TASAS`): `periodicidad: 'mensual'`, `coleccion: 'indicesmensuales'`, `fuente`, unidades, `atrasoPublicacionDias` (75; queda como respaldo) y `publicacion: { mesesDespues, dia }`, el calendario con el que se decide si la serie está al día (10.8).

`verificarFechasFaltantes(tipoTasa)` detecta la periodicidad y deriva en `verificarPeriodosMensuales`, que recorre los períodos guardados y escribe:

| campo | contenido |
|---|---|
| `fechaInicio` / `fechaUltima` | primer y último mes con dato |
| `fechaUltimaCompleta` | último mes hasta el cual no falta ninguno |
| `fechasFaltantes` | un `Date` por cada mes sin dato entre el primero y el último |
| `ultimoPeriodo` | último mes publicado, `AAAA-MM` |
| `ultimaVerificacion` | cuándo se computó |

Se recalcula en cada actualización de la serie (`sincronizarConfig`).

### 10.3. Actualización

- **Cron** `indices-mensuales`: todos los días 10:10, 17:10 y 21:10 (`cronConfig.indicesMensuales.actualizacion`); la lectura de las 17:10 toma el IPC el mismo día en que el INDEC lo publica (16 h). Relee **los últimos 12 meses** de cada serie y hace upsert; los dos últimos meses del RIPTE se marcan `provisorio`.
- **Carga histórica**: `node scripts/backfillIndicesMensuales.js [--dry-run] [--serie=<serie>]`, desde el `desde` de cada serie.

### 10.4. Estado al 2026-11-23

`tasasconfigs`: 23 series, todas con 0 faltantes. Mensuales: `inflacionMensual` 1943-03 → 2026-10 (1.004 meses), `ipc` 2016-12 → 2026-10 (119), `ripte` 1994-07 → 2026-08 (386, 2 provisorios). Sin huecos en ninguna de las 12 series de `indicesmensuales`.

### 10.5. Por qué una serie puede no estar al día, y qué se hizo (2026-11-23)

Dos causas, las dos encontradas ese día:

**a) La fuente era una republicación.** El RIPTE se leía solo de datos.gob.ar, que copia la serie de la Secretaría de Trabajo con demora y sin control:

| período | datos.gob.ar | página oficial |
|---|---|---|
| 2026-08 | 1.915.878,76 (repite el valor de junio) | 1.982.518,19 |
| 2026-09 | no lo tiene | 2.022.244,09 |

Corrección en el código (rama `fix/indices-fuente-oficial-ripte`): `leerRipteOficial()` lee la tabla de la página oficial y `superponerOficial()` la aplica sobre la serie de datos.gob.ar — los meses que publica la fuente oficial reemplazan o agregan, cada documento guarda de qué fuente salió, y las diferencias van al log como `warn`. Si la página oficial no responde o cambia de formato, el servicio sigue con datos.gob.ar. `atrasoPublicacionDias` del RIPTE pasa de 110 a 75. Test: `server/tests/unit/services/ripteOficial.test.js`, con la página guardada como fixture.

**b) El cron relee 12 meses.** Si la fuente revisa un valor más viejo no se recoge, y la configuración sigue diciendo "0 faltantes" porque mide presencia, no exactitud:

| serie | período | en `indicesmensuales` | en la fuente |
|---|---|---|---|
| `ipc` | 2019-04 | 212,9596414 | 213,0517 |
| `ipc` | 2024-05 | 6073,7 | 6073,7165 |

Corrección en el código: tarea nueva `indices-mensuales-relectura`, domingos 10:40, que llama `actualizarTodas({ completa: true })` y relee cada serie desde su inicio.

**Hasta que se despliegue**, los valores de arriba siguen mal en Atlas. Corrección puntual, como root en el hub: `node scripts/backfillIndicesMensuales.js --serie=ipc` y `--serie=ripte`.

Lo que **no** es un atraso: el IPC llega hasta el mes anterior al último cerrado (INDEC publica a mediados del mes siguiente) y las tasas diarias llegan hasta hoy o más allá.

### 10.6. Agregar una serie mensual

1. Entrada en `SERIES_MENSUALES` (`origen`, `id`, `tipo`, `tipoIndice`, `descripcion`, `fuente`, `desde`). Fuentes soportadas: `bcra` y `datosgob`; otra fuente necesita su lector.
2. Si debe ofrecerse como tasa: entrada en `CATALOGO_TASAS` y en el `enum` de `tipoTasa` de `server/models/tasasConfig.js`. El documento de configuración se crea solo en la primera verificación.
3. `node scripts/backfillIndicesMensuales.js --dry-run --serie=<serie>` y después sin `--dry-run`.
4. Deploy: `git pull` en `/var/www/admin` y `pm2 restart law-analytics-tasas`.

### 10.7. Movilidad previsional

No está acá: los aumentos generales de ANSES y los factores de los criterios del retroactivo viven en `datosprevisionales` (ver `DATOS_PREVISIONALES.md`). `movilidadLey27426` —lo que habría dado la ley 27.426— estaba cargada solo para 2020; el 2026-11-23 se extendió de marzo de 2021 a junio de 2024 (catorce trimestres) con `scripts/cargarMovilidadLey27426.js`, que la calibra contra los ocho aumentos reales de 2018-2019 antes de escribir. Se calcula con `ipc` y `ripte` de esta colección (70 % de la variación del IPC más 30 % de la del RIPTE del trimestre cerrado seis meses antes).

### 10.8. Al día por calendario, aviso por correo y seguimiento en tareas del admin

**Cuándo una serie mensual está al día.** No por días de atraso sino por período: `publicacion: { mesesDespues, dia }` en el catálogo dice que el dato del mes M debe estar el día `dia` del mes M + `mesesDespues` (`server/utils/calendarioPublicacion.js`).

| serie | regla | ejemplo |
|---|---|---|
| `ipc` | mes siguiente, día 18 | el IPC de octubre se espera desde el 18/11 |
| `inflacionMensual` | mes siguiente, día 22 | el BCRA lo toma unos días después del INDEC |
| `ripte` | segundo mes siguiente, día 20 | el RIPTE de septiembre se espera desde el 20/11 |

Con el margen fijo anterior (75 o 110 días desde el fin del último mes) un atraso real tardaba semanas en verse: el 23/11/2026 el RIPTE estaba en agosto y figuraba "al día". Lo usan el reporte diario de tasas (`verificadorTasas`) y `GET /api/tasas/status` (`serieAlDia`).

**Correo.** No hay un correo aparte: los índices mensuales van en el **reporte diario de tasas y datos previsionales** que ya se envía (9:00 y 23:00, y como alerta tras cada ciclo si algo está desactualizado), en la sección "Índices mensuales" (`server/services/audit/estadoIndicesMensuales.js`): último mes, valor y variación, si está al día, cuándo se espera el próximo dato y qué llegó o se corrigió en las últimas 24 horas.

- *Llegó un dato o la fuente corrigió uno*: el documento queda marcado (`novedadEn`, `novedadTipo`, `valorAnterior`) y el reporte lo muestra durante 24 horas, también en el asunto ("RIPTE 2026-09: 2.022.244,09").
- *Falta un dato*: la serie que no llegó al período esperado cuenta como tasa desactualizada, con lo que el reporte sale como `[ALERTA]`.

**Tareas del admin** (`server/services/seguimiento/seguimientoIndices.js`, colección `admintasks`, vista `/admin/tasks`, proyecto `tasas`). Una tarea por serie, que se reutiliza (se ubica por `metadata.seguimientoIndice`):

- `ipc`, `ripte`, `inflacionMensual`: vence el día en que se espera el mes siguiente. Cuando el cron lo lee, anota el valor como comentario y corre el vencimiento un mes. Si el mes no llega, la tarea queda vencida y pasa a prioridad alta.
- `tasas-diarias`: una sola para todas las series diarias; vence al día siguiente y la verificación de tasas la renueva mientras estén todas al día. Con alguna atrasada no se renueva y la descripción lista cuáles.

Un vencimiento nuevo abre un ciclo: la tarea vuelve a "por hacer" aunque se la haya cerrado a mano. Archivarla no la detiene (se sigue actualizando archivada); para dejar de seguir una serie hay que quitarle `publicacion` del catálogo.

Tests: `server/tests/unit/services/seguimientoIndices.test.js`.
