import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {expect} from 'chai'

import {detectLocalVercelProject} from '../../src/lib/local-vercel.js'

describe('detectLocalVercelProject', () => {
  it('finds .vercel/project.json from nested directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'doomain-'))

    try {
      mkdirSync(join(root, '.vercel'), {recursive: true})
      mkdirSync(join(root, 'src', 'app'), {recursive: true})
      writeFileSync(join(root, '.vercel', 'project.json'), JSON.stringify({orgId: 'team_123', projectId: 'prj_123'}))

      const detected = detectLocalVercelProject(join(root, 'src', 'app'))
      expect(detected).to.deep.equal({orgId: 'team_123', projectId: 'prj_123', root})
    } finally {
      rmSync(root, {force: true, recursive: true})
    }
  })
})
