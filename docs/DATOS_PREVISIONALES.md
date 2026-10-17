# Datos previsionales (`datosprevisionales`)

Colección de Atlas con **un documento por mes** (`fecha` = día 1, UTC) con los valores oficiales que usan los cálculos
previsionales del hub (retroactivo, haber de caja, haber mínimo con el piso del 82 % del SMVM). Este repo la mantiene al
día leyendo las normas de **InfoLeg**; el hub solo la lee (`law-analytics-server/models/DatosPrevisionales.js`, mismo
esquema que `server/models/datosprevisionales.js`).

Regla de la casa: **cada valor tiene norma**. Nada se extrapola ni se carga sin la resolución o el decreto que lo fija.

| Pieza | Archivo |
|---|---|
| Sincronizador (lectura de InfoLeg, propuesta, escritura, revertir, tarea programada) | `server/services/scrapers/previsional/datosPrevisionalesService.js` |
| Script manual (prueba / aplicar / forzar / revertir) | `scripts/sincronizarDatosPrevisionales.js` |
| Estado para el reporte diario de tasas | `server/services/audit/estadoDatosPrevisionales.js` |
| Reporte por correo (tasas + datos previsionales) | `server/utils/verificadorTasas.js` |
| Auditoría de cobertura de fin de mes | `server/services/audit/auditDatosPrevisionalesService.js` |
| Programación de las tareas | `server/config/cronConfig.js`, `server/services/tasks/taskService.js` |
| Datos del haber de caja (índices, rentas, PBU de altas) | `server/data/previsional/haber-caja.json`, `scripts/haberCaja/` |
| Tests | `server/tests/unit/services/datosPrevisionales.test.js`, `estadoDatosPrevisionales.test.js` (fixtures en `server/tests/fixtures/previsional/`) |

---

## 1. De dónde salen los datos

| Fuente | Cómo se encuentra en InfoLeg | Qué aporta |
|---|---|---|
| **Resoluciones mensuales de ANSES** (movilidad, DNU 274/2024 desde 4/2024) | Vínculos ("normas que modifican o complementan") de la **ley 24.241** (id 639) y del **DNU 274/2024** (id 397577). Ninguna de las dos listas está completa sola (p. ej. la Res. 66/2025 solo figura en la de la ley 24.241). | % de movilidad, haber mínimo y máximo, base imponible mínima y máxima, PBU, PUAM. El mes sale del texto ("vigente a partir del mes de X"), no de la fecha de publicación. |
| **Decretos de bono previsional** | Vínculos de la ley 24.241 + búsqueda por texto, tipo Decreto, año por año ("ingreso previsional", "subsidio extraordinario", "bono extraordinario previsional", "ayuda económica previsional"). Los que no aparecen ni así van fijos (Dec. 309/2020). | Monto máximo del bono (el que cobra quien percibe hasta el haber mínimo), escalones y decreto. Los subsidios de la AUH se ignoran. |
| **Salario mínimo, vital y móvil** (otro tipo de norma) | Búsqueda por dependencia del **Consejo Nacional del Empleo, la Productividad y el SMVM**: 3333 (nombre actual) y 18 (nombre viejo, usado aún en 2022). Se mira 30 meses hacia atrás. | Tramos "a partir del 1° de <mes>": una resolución suele fijar varios meses hacia adelante (la Res. 4/2026 fija 9/2026 → 4/2027). Si dos resoluciones fijan el mismo tramo, gana la más nueva. |

Ojo: la serie de datos.gob.ar del SMVM tiene meses mal rellenados; por eso se lee la resolución.

## 2. Qué se guarda en cada mes

Campos que escribe la sincronización (`CAMPOS` en el servicio):

- De la resolución de ANSES: `movilidadGeneral`, `haberMinimoJubilacion`, `haberMaximoJubilacion`, `maximoImponible`,
  `baseImponibleMinima`, `pbu`, `puam`, `norma`, `links`, `fuentes`.
- Derivados (reglas verificadas contra lo cargado a mano 2018–2026):
  - `haberMinimoPension = haberMinimoJubilacion`; `haberMaximoPension = haberMaximoJubilacion`.
  - `movilidadGeneral = 1 + %/100` (4 decimales). Si la resolución no trae el % (abril 2024), sale del cociente de
    haberes mínimos con el mes anterior.
  - `topePC` = `topePC` del mes anterior × `movilidadGeneral`, a centavos.
- Del bono: `bono`, `bonoNorma`, `bonoEscalones`.
- Del salario mínimo: `salarioMVM`, `normaSMVM` (si en un mes no hay resolución nueva, queda el último tramo vigente con
  la aclaración "(tramo de AAAA-MM, vigente)").
- **`suplemento82SMVM = máx(0; 0,82 × SMVM − haber mínimo)`**: lo que hay que sumar al haber mínimo de ANSES para llegar
  al 82 % del salario mínimo (ley 27.426, art. 2). **No es el 82 % del SMVM.** El haber mínimo garantizado es
  `haberMinimoJubilacion + suplemento82SMVM`. Fue mayor a 0 en 35 meses (1/2018 → 5/2024; p. ej. 3/2024: 82 % de
  202.800 = 166.296 contra haber mínimo 134.445,30 → suplemento 31.850,70). Desde 6/2024 el haber mínimo de ANSES supera
  el 82 % y da 0; si se vuelve a invertir, se calcula solo.

Un mes nuevo se crea **solo si su resolución de ANSES ya salió** (sin `haberMinimoJubilacion` no se crea). Los campos
fijos de un mes nuevo están en `DEFAULTS_MES_NUEVO` (moneda pesos, ferroviarios en 0, etc.).

Los campos del **haber de caja** (`indicesRemuneraciones`, `rentasAutonomos`, `pbuAltas`, `factorSuplementoAltas`,
`pcPctPorAnio`, `papPctPorAnio`, `normas`) no vienen de InfoLeg: los arma `scripts/haberCaja/armarDatosHaberCaja.js`
desde la investigación del 12/10/2026 (`la-ads/analysis/2026-10-12-haber-caja-investigacion.md`) y los aplica
`scripts/haberCaja/cargarDatosHaberCaja.js` (prueba, `--apply`, `--forzar`, `--campos`, `--revertir`), con la norma de
cada campo en `normas.<campo>`.

## 3. Cómo escribe: solo completar, auditado y revertible

Por cada mes del rango compara lo cargado con lo que dice la norma (`diffMes`), campo por campo:

| Estado | Qué es | Qué hace |
|---|---|---|
| `igual` | coincide (con tolerancia: 0,005 en montos, 1e-6 en movilidad) | nada |
| `nuevo` | el campo está vacío (un 0 cuenta como vacío, salvo en `bono` y `suplemento82SMVM`, donde 0 es un valor) | lo escribe con `aplicar` |
| `conflicto` | hay un valor cargado y distinto | **no lo pisa** salvo con `forzar`; queda en el informe y en el log |

Casos de desfase entre normas:

- El bono sale días después que la resolución de ANSES: el mes nace con `bono` 0 sin norma y una corrida posterior lo
  completa cuando aparece el decreto.
- El salario mínimo sale después: el mes nace con `salarioMVM` 0 ("sin dato"); cuando aparece la resolución del Consejo
  se completa y `suplemento82SMVM` se recalcula. Si sale antes (lo habitual, porque fija varios meses), el mes nace con
  todo.

Cada escritura queda en **`datosprevisionales-sincronizaciones`** con su `corrida` (`datosprev-AAAAMMDD-HHmmss`), el
valor anterior y el nuevo. `revertir(corrida)` borra los meses creados y restaura los campos; exige la corrida (sin ella
tira error, para no tocar documentos sin corrida).

En la misma colección vive el documento **`_id: 'ultimo-aviso'`** (sin campo `corrida`), que reescribe cada corrida
del cron: errores de lectura vigentes (`errores`, `erroresNormas`), `resumen` (nuevos, campos nuevos, conflictos,
escritos), `ansesHasta` (último mes con resolución de ANSES leída), `smvmHasta` (último tramo de SMVM fijado),
`ultimaCorrida` y `actualizado`. Lo usan el aviso del cron y el reporte diario.

## 4. Tareas programadas

Zona horaria del cron: `America/Argentina/Buenos_Aires`.

| TaskID | Programación | Qué hace |
|---|---|---|
| `sync-datos-previsionales` | **todos los días 12:20 y 18:20** (`20 12,18 * * *`) | `runTareaSincronizacion`: sincroniza en modo "solo completar" desde 3 meses atrás (o desde el mes siguiente al último cargado si quedó un hueco mayor). Tarda ~15 s. Manda email a soporte@ solo si **escribió algo** o aparece un **error de lectura nuevo** (los ya avisados y los conflictos quedan en el log, para no repetir el correo en cada corrida). El asunto nombra el mes nuevo: `[datosprevisionales] mes nuevo 2026-11 · 19 campos escritos · …`, y el cuerpo trae el comando para revertir. |
| `audit-datos-previsionales` | días 28–31 a las 22:00; solo actúa el último día real del mes | Auditoría de cobertura del mes próximo (documento, movilidad, haber mínimo, SMVM); email solo si hay faltantes. |
| `verificacion-tasas-matutina` / `-diaria` | 9:00 y 23:00 | Reporte de tasas **con la sección de datos previsionales** (ver §5). Siempre se envía. |
| `verificacion-tasas-ciclica` | 7:55, 9:55, 11:55, 13:55, 15:55, 21:55 | Mismo reporte, solo si falla alguna tasa. Un problema previsional solo no lo dispara (aparece en el de las 9 y las 23). |

Hasta el 17/10/2026 la sincronización corría lunes y jueves 12:20 más los días 25–31 a las 18:20; se pasó a diaria porque
ANSES, el Consejo del Salario y los decretos de bono publican todos los meses pero sin día fijo (y el Boletín Oficial a
veces saca ediciones extraordinarias en fin de semana).

## 5. Reporte diario por correo (tasas + datos previsionales)

`verificadorTasas.js` arma el correo de verificación de tasas y le suma la sección **"Datos previsionales
(sincronización con InfoLeg)"** (`estadoDatosPrevisionales.js`):

- **Último mensual con datos**: mes, resolución, movilidad y haber mínimo (y si le falta SMVM o decreto del bono).
- **Mes en curso**: con datos o **SIN DATOS**.
- **Mensuales pendientes** a la fecha, cada uno con su estado: `atrasado` (mes anterior al corriente), `mes en curso sin
  datos`, `pendiente de publicación` (el mes próximo: es lo normal hasta que ANSES publica, suele ser la última semana).
- **Última corrida del cron** (fecha, hace cuántas horas, si escribió), **normas leídas** (ANSES hasta, SMVM fijado
  hasta) y **errores de lectura / conflictos**.

Asunto (cambió el 17/10/2026; antes era "[ÉXITO] Todas las Tasas Actualizadas" / "[ALERTA] Tasas Desactualizadas"):

```
[OK] Tasas y datos previsionales 2026-10-17 · tasas al día · datos previsionales al día hasta 2026-10
[AVISO] Tasas y datos previsionales … · tasas al día · 2026-11 sin salario mínimo ni decreto del bono
[ALERTA] Tasas y datos previsionales … · 2 tasas desactualizadas · mes en curso 2026-11 sin datos previsionales
```

| Nivel | Cuándo |
|---|---|
| `[ALERTA]` | tasas desactualizadas o con errores de scraping; mes en curso o anteriores sin datos previsionales; el cron no corre hace más de 36 h; normas de InfoLeg que no se pueden leer; no se pudo leer el estado |
| `[AVISO]` | al mes en curso le falta el salario mínimo o el decreto del bono; no hay registro de corridas del cron |
| `[OK]` | todo al día |

Un mes "tiene datos" si `movilidadGeneral > 0` y `haberMinimoJubilacion > 0`. Si leer el estado previsional falla, el
reporte de tasas sale igual con la sección en error.

## 6. Uso manual

```bash
# Prueba (no escribe): diff campo a campo
node scripts/sincronizarDatosPrevisionales.js --desde=2024-04 [--hasta=2026-10] [--solo-cambios] [--json]

# Escribir meses nuevos y campos vacíos
node scripts/sincronizarDatosPrevisionales.js --desde=2026-09 --apply

# Pisar conflictos (solo con la norma a la vista) o limitar campos
node scripts/sincronizarDatosPrevisionales.js --desde=2024-04 --apply --forzar
node scripts/sincronizarDatosPrevisionales.js --desde=2019-11 --apply --campos=bono,bonoNorma,bonoEscalones

# Deshacer una corrida
node scripts/sincronizarDatosPrevisionales.js --revertir=datosprev-20261012-163843
```

Tests: `npx mocha server/tests/unit/services/*.test.js` (parseo de resoluciones de ANSES, decretos de bono y
resoluciones del SMVM con HTML real de InfoLeg; propuesta y diff; aviso del cron; estado del reporte).

## 7. Verificación y estado

- **12/10/2026**: carga inicial con el sincronizador: corrida `datosprev-20261012-163843` (2024-04 → 2026-10, con
  `--forzar`, 206 cambios, 5 meses creados) y `datosprev-20261012-165910` (bonos desde 2019-11, `--campos`).
- **17/10/2026**, sin escribir:
  - Prueba de 2024-04 a 2026-10 (31 meses): lo que dice InfoLeg coincide con lo guardado (0 conflictos, 0 errores).
  - Simulación de mes nuevo (agosto, septiembre y octubre de 2026 tomados como ausentes): crearía los tres con la Res.
    ANSES 232, 257 y 284/2026 y los 19 campos de cada uno dan igual a lo cargado.
- Último mes cargado al 17/10/2026: **2026-10** (Res. ANSES 284/2026, movilidad 1,66 %, haber mínimo 435.748,51, bono
  70.000 por Dec. 1108/2026, SMVM 391.200 por Res. 4/2026). SMVM fijado hasta 2027-04.
- Primer mes que debería cargar el cron sin intervención: **2026-11**, cuando ANSES publique la resolución (última
  semana de octubre). Si cambia el formato del texto y no se puede leer, el mes no se carga y llega el aviso de error:
  nunca se escribe un valor mal leído.

Despliegue: hub `/var/www/admin` → `git pull` + `pm2 restart law-analytics-tasas` (commits d29ac89 y bfb1c81 del
17/10/2026).

## 8. Pendientes conocidos

- Los retroactivos guardados en el front no se recalculan solos cuando entra un mes nuevo (no hay keepUpdated para
  `classType: previsional`): hoy se reabren y se guardan de nuevo desde Guardados.
- Si cambia el esquema de `datosprevisionales` en el hub, replicarlo en `server/models/datosprevisionales.js`.
