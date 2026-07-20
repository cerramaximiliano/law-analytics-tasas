/**
 * Sincronización de IUS SAL — envoltorio sobre el sync genérico.
 */

'use strict';

const { obtenerValores } = require('./iusSaltaService');
const { sincronizarValores } = require('./valoresArancelariosSyncService');

function sincronizarIusSalta({ simular = false } = {}) {
  return sincronizarValores({
    obtener: () => obtenerValores(),
    etiqueta: 'IUS SAL',
    clave: 'ius-sal',
    simular
  });
}

module.exports = { sincronizarIusSalta };
