/**
 * Sincronización del valor UMA (CPACF) — envoltorio sobre el sync genérico.
 * La lógica común vive en valoresArancelariosSyncService; acá solo se ata el
 * scraper del CPACF. Se conserva la firma `sincronizarUma` porque el cron ya
 * deployado la referencia.
 */

'use strict';

const { obtenerValores } = require('./umaCpacfService');
const { sincronizarValores } = require('./valoresArancelariosSyncService');

function sincronizarUma({ ambito = 'PJN', simular = false } = {}) {
  return sincronizarValores({
    obtener: () => obtenerValores(ambito),
    etiqueta: `UMA ${ambito}`,
    clave: ambito === 'CABA' ? 'uma-caba' : 'uma-pjn',
    simular
  });
}

module.exports = { sincronizarUma };
