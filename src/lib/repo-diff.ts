// ─────────────────────────────────────────────────────────────
// VibeCheck · Diff de árboles de archivos (modo diff)
// Puro y sin I/O: comparar dos snapshots path→contenido.
// ─────────────────────────────────────────────────────────────

export interface TreeDiff {
  /** Existen en head pero no en base */
  added: string[]
  /** Existen en ambos pero el contenido cambió */
  modified: string[]
  /** Existían en base y ya no están en head */
  deleted: string[]
}

export function diffTrees(base: Map<string, string>, head: Map<string, string>): TreeDiff {
  const added: string[] = []
  const modified: string[] = []
  const deleted: string[] = []

  for (const [path, content] of head) {
    if (!base.has(path)) added.push(path)
    else if (base.get(path) !== content) modified.push(path)
  }
  for (const path of base.keys()) {
    if (!head.has(path)) deleted.push(path)
  }

  return {
    added: added.sort(),
    modified: modified.sort(),
    deleted: deleted.sort(),
  }
}

/** Los archivos que se auditan en modo diff (los que cambió el repo), en orden determinista */
export function changedPaths(diff: TreeDiff): Set<string> {
  return new Set([...diff.added, ...diff.modified].sort())
}
