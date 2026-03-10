require('dotenv').config();
const mongoose = require('mongoose');
const path = require('path');

mongoose.connect(process.env.URLDB).then(async () => {
  const Tasas = require(path.join(__dirname, '../server/models/tasas'));

  const tasas = ['tasaPasivaBP', 'tasaActivaBPDolares', 'tasaPasivaBPDolares'];

  for (const tipoTasa of tasas) {
    const docs = await Tasas.find(
      { [tipoTasa]: { $exists: true, $ne: null } },
      { fecha: 1, [tipoTasa]: 1 }
    ).sort({ fecha: 1 }).lean();

    if (docs.length < 2) { console.log(tipoTasa + ': insuficientes datos'); continue; }

    // Calcular gaps entre fechas consecutivas
    const gaps = {};
    for (let i = 1; i < docs.length; i++) {
      const diff = Math.round((docs[i].fecha - docs[i-1].fecha) / (1000*60*60*24));
      gaps[diff] = (gaps[diff] || 0) + 1;
    }

    // Contar valores únicos (cambios reales)
    const unique = new Set(docs.map(d => d[tipoTasa])).size;

    console.log(`\n${tipoTasa}: ${docs.length} registros | ${unique} valores únicos`);
    console.log('  Distribución de gaps (días entre registros):');
    Object.entries(gaps).sort((a,b) => Number(a[0])-Number(b[0])).slice(0,8).forEach(([days, count]) => {
      console.log(`    ${days} día(s): ${count} veces`);
    });
  }

  await mongoose.connection.close();
  process.exit(0);
}).catch(e => { console.error(e.message); process.exit(1); });
