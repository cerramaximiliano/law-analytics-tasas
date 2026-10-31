const assert = require('assert');
const { storageBytes } = require('../../../services/stats/statsSyncService');

const sizes = { contact: 2048, folder: 10240, folderLinked: 51200, calculator: 5120 };

describe('statsSyncService.storageBytes', () => {
  it('separa carpetas vinculadas de básicas y suma el total', () => {
    const bytes = storageBytes({ folders: 3, foldersLinked: 2, contacts: 4, calculators: 1 }, sizes);
    assert.deepStrictEqual(bytes, { folders: 112640, contacts: 8192, calculators: 5120, total: 125952 });
  });

  it('sin archivados da 0 (repara lo que quedó desincronizado)', () => {
    assert.deepStrictEqual(storageBytes({}, sizes), { folders: 0, contacts: 0, calculators: 0, total: 0 });
  });
});
