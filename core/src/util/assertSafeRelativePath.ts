import path from "node:path";

export function assertSafeRelativePath(baseDir: string, relativePath: string): void {
  const resolvedBase = path.resolve(baseDir) + path.sep;
  const resolvedTarget = path.resolve(baseDir, relativePath);
  if (!resolvedTarget.startsWith(resolvedBase)) {
    throw new Error(`Ruta de archivo generada no permitida, sale del directorio esperado: ${relativePath}`);
  }
}
