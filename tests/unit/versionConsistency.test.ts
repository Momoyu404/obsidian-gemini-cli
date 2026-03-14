import * as fs from 'fs';
import * as path from 'path';

describe('release version consistency', () => {
  const root = path.resolve(__dirname, '../..');
  const releaseVersion = process.env.RELEASE_VERSION;

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

  it('matches the expected release version when provided', () => {
    if (!releaseVersion) {
      expect(true).toBe(true);
      return;
    }

    const packageJson = readJson('package.json');
    const manifestJson = readJson('manifest.json');
    const lockfileJson = readJson('package-lock.json');

    expect(packageJson.version).toBe(releaseVersion);
    expect(manifestJson.version).toBe(releaseVersion);
    expect(lockfileJson.version).toBe(releaseVersion);
    expect(lockfileJson.packages[''].version).toBe(releaseVersion);
  });
});
