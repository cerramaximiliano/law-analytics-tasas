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

  tasaPasivaBNA: 'interesDiario',
  tasaActivaBNA: 'interesDiario',
  tasaActivaTnaBNA: 'interesDiario',
  tasaActivaCNAT2601: 'interesDiario',
  tasaActivaCNAT2658: 'interesDiario',
  tasaActivaCNAT2764: 'interesDiario',
  tasaPasivaBP: 'interesDiario',
  tasaActivaBPDolares: 'interesDiario',
  tasaPasivaBPDolares: 'interesDiario',
};

function getTipoIndice(tipoTasa) {
  return TIPO_INDICE_POR_TASA[tipoTasa] || 'interesDiario';
}

module.exports = { TIPO_INDICE_POR_TASA, getTipoIndice };
