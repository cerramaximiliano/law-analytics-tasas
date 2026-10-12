// Mapeo entre tipoTasa y tipoIndice. Lo consume law-analytics-server para
// elegir la fórmula de cálculo en /api/tasas/consulta?calcular=true:
//   - 'indexado'           → (Vf / Vi) - 1                              (CER, ICL: índices base 1)
//   - 'porcentajeAcumulado'→ (Vf + 100) / (V_día_anterior + 100) - 1    (tasaPasivaBCRA / 27802)
//   - 'interesDiario'      → sumatoria de TNAs diarias / 100            (resto)
const TIPO_INDICE_POR_TASA = {
  cer: 'indexado',
  icl: 'indexado',
  tasaPasivaBCRA: 'porcentajeAcumulado',
  tasaPasivaBCRA27802: 'porcentajeAcumulado',
  uva: 'indexado',
  uvi: 'indexado',
  // TNA de días hábiles del BCRA guardadas como TNA/365 por día, con relleno de días no
  // hábiles (bcraService.actualizarSerieTNA).
  tasaBADLAR: 'interesDiario',
  tasaTAMAR: 'interesDiario',
  tasaTM20: 'interesDiario',

  tasaPasivaBNA: 'interesDiario',
  tasaActivaBNA: 'interesDiario',
  tasaActivaTnaBNA: 'interesDiario',
  tasaActivaCNAT2601: 'interesDiario',
  tasaActivaCNAT2630: 'interesDiario',
  tasaActivaCNAT2658: 'interesDiario',
  tasaActivaCNAT2764: 'interesDiario',
  tasaPasivaBP: 'interesDiario',
  tasaActivaBP: 'interesDiario',
  tasaActivaBPDolares: 'interesDiario',
  tasaPasivaBPDolares: 'interesDiario',
};

/**
 * Catálogo de configuración de las series nuevas (backlog la-ads ítem 7, D3 etapa 2). Es la
 * fuente de verdad de lo que se guarda en TasasConfig: verificarFechasFaltantes lo aplica en
 * cada verificación y elige el cómputo según `periodicidad`:
 *   - 'diaria':      un dato por día corrido (UVA, UVI).
 *   - 'diariaHabil': la fuente publica solo días hábiles; se guarda por día corrido con relleno
 *                    de días sin publicación (BADLAR, TAMAR, TM20).
 *   - 'mensual':     un dato por mes en la colección IndicesMensuales (inflación, RIPTE, IPC).
 * Las series que no están en el catálogo se tratan como 'diaria' en la colección 'tasas'.
 */
const CATALOGO_TASAS = {
  uva: {
    tipoIndice: 'indexado', periodicidad: 'diaria', coleccion: 'tasas',
    descripcion: 'UVA (BCRA)', fuente: 'BCRA API v4, variable 31',
    unidadOrigen: 'Pesos por UVA (base 31/03/2016 = 14,05)', unidadAlmacenada: 'Valor diario de la UVA',
    atrasoPublicacionDias: 1,
  },
  uvi: {
    tipoIndice: 'indexado', periodicidad: 'diaria', coleccion: 'tasas',
    descripcion: 'UVI (BCRA)', fuente: 'BCRA API v4, variable 32',
    unidadOrigen: 'Pesos por UVI (base 31/03/2016 = 14,05)', unidadAlmacenada: 'Valor diario de la UVI',
    atrasoPublicacionDias: 1,
  },
  tasaBADLAR: {
    tipoIndice: 'interesDiario', periodicidad: 'diariaHabil', coleccion: 'tasas',
    descripcion: 'Tasa BADLAR bancos privados (TNA)', fuente: 'BCRA API v4, variable 7',
    unidadOrigen: 'TNA % (días hábiles)', unidadAlmacenada: 'TNA/365 por día corrido (%); días sin publicación repiten el último valor',
    atrasoPublicacionDias: 6,
  },
  tasaTAMAR: {
    tipoIndice: 'interesDiario', periodicidad: 'diariaHabil', coleccion: 'tasas',
    descripcion: 'Tasa TAMAR bancos privados (TNA)', fuente: 'BCRA API v4, variable 44',
    unidadOrigen: 'TNA % (días hábiles)', unidadAlmacenada: 'TNA/365 por día corrido (%); días sin publicación repiten el último valor',
    atrasoPublicacionDias: 6,
  },
  tasaTM20: {
    tipoIndice: 'interesDiario', periodicidad: 'diariaHabil', coleccion: 'tasas',
    descripcion: 'Tasa TM20 bancos privados (TNA)', fuente: 'BCRA API v4, variable 8',
    unidadOrigen: 'TNA % (días hábiles)', unidadAlmacenada: 'TNA/365 por día corrido (%); días sin publicación repiten el último valor',
    atrasoPublicacionDias: 6,
  },
  inflacionMensual: {
    tipoIndice: 'variacionMensual', periodicidad: 'mensual', coleccion: 'indicesmensuales',
    descripcion: 'Inflación mensual (IPC INDEC)', fuente: 'BCRA API v4, variable 27 (IPC INDEC)',
    unidadOrigen: 'Variación % mensual', unidadAlmacenada: 'Variación % del mes',
    atrasoPublicacionDias: 75,
  },
  ripte: {
    tipoIndice: 'indiceMensual', periodicidad: 'mensual', coleccion: 'indicesmensuales',
    descripcion: 'RIPTE', fuente: 'datos.gob.ar, serie 158.1_REPTE_0_0_5',
    unidadOrigen: 'Pesos (remuneración promedio)', unidadAlmacenada: 'Nivel del mes',
    atrasoPublicacionDias: 110,
  },
  ipc: {
    tipoIndice: 'indiceMensual', periodicidad: 'mensual', coleccion: 'indicesmensuales',
    descripcion: 'IPC INDEC (nivel general)', fuente: 'datos.gob.ar, serie 148.3_INIVELNAL_DICI_M_26',
    unidadOrigen: 'Índice base dic-2016 = 100', unidadAlmacenada: 'Nivel del mes',
    atrasoPublicacionDias: 75,
  },
};

function getTipoIndice(tipoTasa) {
  return (CATALOGO_TASAS[tipoTasa] && CATALOGO_TASAS[tipoTasa].tipoIndice) || TIPO_INDICE_POR_TASA[tipoTasa] || 'interesDiario';
}

/** Campos de configuración del catálogo para un tipoTasa (vacío si no está catalogado). */
function getConfigCatalogo(tipoTasa) {
  return CATALOGO_TASAS[tipoTasa] ? { ...CATALOGO_TASAS[tipoTasa] } : {};
}

module.exports = { TIPO_INDICE_POR_TASA, CATALOGO_TASAS, getTipoIndice, getConfigCatalogo };
