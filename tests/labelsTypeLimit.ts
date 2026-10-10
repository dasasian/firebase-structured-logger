/**
 * Pinned by `npm run typecheck`; there is nothing to run.
 *
 * The labels type parameter of `initLogger` and `withLogging` is limited to
 * `Record<string, string | undefined>`. A `type` alias satisfies that and an `interface` does
 * not (TS2344, no index signature), which is why CAPABILITIES.md writes its labels type as an
 * alias. If someone loosens the limit, the `@ts-expect-error` lines below stop compiling.
 */

import { initLogger as initClientLogger } from '../src/client/index.js'
import { withLogging } from '../src/functions/index.js'

type LabelsWrittenAsTypeAlias = { organizationId?: string }
interface LabelsWrittenAsInterface {
  organizationId?: string
}

const CLIENT_INIT_ACCEPTS_LABELS_TYPE_ALIAS_PINNED_BY_TYPECHECK = initClientLogger<LabelsWrittenAsTypeAlias>
const WITH_LOGGING_ACCEPTS_LABELS_TYPE_ALIAS_PINNED_BY_TYPECHECK = withLogging<LabelsWrittenAsTypeAlias>

// @ts-expect-error TS2344: an interface has no index signature
const CLIENT_INIT_REJECTS_LABELS_INTERFACE_PINNED_BY_TYPECHECK = initClientLogger<LabelsWrittenAsInterface>
// @ts-expect-error TS2344: an interface has no index signature
const WITH_LOGGING_REJECTS_LABELS_INTERFACE_PINNED_BY_TYPECHECK = withLogging<LabelsWrittenAsInterface>
