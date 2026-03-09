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
