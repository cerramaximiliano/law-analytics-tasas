// Mapeo entre tipoTasa y tipoIndice. Lo consume law-analytics-server para
// elegir la fórmula de cálculo en /api/tasas/consulta?calcular=true:
//   - 'indexado'      → (valorFinal / valorInicial) - 1   (CER, ICL, BCRA pasiva)
//   - 'interesDiario' → sumatoria de TNAs diarias / 100   (todas las demás)
const TIPO_INDICE_POR_TASA = {
  cer: 'indexado',
  icl: 'indexado',
  tasaPasivaBCRA: 'indexado',
  tasaPasivaBCRA27802: 'indexado',

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
