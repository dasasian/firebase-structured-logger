/**
 * Replaces `@google-cloud/storage` with a client that records how it was constructed and
 * uploads nothing. Import it before the module under test: that module requires Storage
 * when it loads.
 */

import Module from 'module'

type Load = (request: string, parent: unknown, isMain: boolean) => unknown

export const storageConstructions: Array<Record<string, unknown>> = []

class FakeStorage {
  constructor(options: Record<string, unknown> = {}) {
    storageConstructions.push(options)
  }

  bucket() {
    return { file: () => ({ save: async () => {} }) }
  }
}

const loader = Module as unknown as { _load: Load }
const originalLoad = loader._load

loader._load = function (request, parent, isMain) {
  if (request === '@google-cloud/storage') return { Storage: FakeStorage }
  return originalLoad.call(this, request, parent, isMain)
}
