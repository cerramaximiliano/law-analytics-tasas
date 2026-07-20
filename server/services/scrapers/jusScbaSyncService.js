/**
 * Sincronización del valor del JUS de la Provincia de Buenos Aires (SCBA) —
 * envoltorio sobre el sync genérico, atando el scraper de la SCBA.
 */

'use strict';

const { obtenerValores } = require('./jusScbaService');
const { sincronizarValores } = require('./valoresArancelariosSyncService');

function sincronizarJusScba({ simular = false } = {}) {
  return sincronizarValores({
    obtener: () => obtenerValores(),
    etiqueta: 'JUS PBA',
    simular
  });
}

module.exports = { sincronizarJusScba };
