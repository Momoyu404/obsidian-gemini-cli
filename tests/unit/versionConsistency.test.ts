import * as fs from 'fs';
import * as path from 'path';

describe('release version consistency', () => {
  const root = path.resolve(__dirname, '../..');

  function readJson(relativePath: string): any {
    const filePath = path.join(root, relativePath);
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  it('keeps package, manifest, and lockfile versions aligned', () => {
    const packageJson = readJson('package.json');
    const manifestJson = readJson('manifest.json');
    const lockfileJson = readJson('package-lock.json');

    expect(manifestJson.version).toBe(packageJson.version);
    expect(lockfileJson.version).toBe(packageJson.version);
    expect(lockfileJson.packages[''].version).toBe(packageJson.version);
  });
});
