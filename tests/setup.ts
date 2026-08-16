import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const testHome = mkdtempSync(join(tmpdir(), 'dsh-delay-tools-test-'))
process.env.DSH_HOME = testHome
