import { describe, expect, it } from 'vitest'
import { resolveCollaborationOrigin } from '../src/main/modules/collaboration/collaboration-endpoint'

describe('desktop collaboration endpoint', () => {
  it('uses the tunnel hostname by default', () => {
    expect(resolveCollaborationOrigin('')).toBe('https://collab.casebang.tech')
  })

  it('normalizes a secure override', () => {
    expect(resolveCollaborationOrigin('https://test.example.com/api/')).toBe('https://test.example.com/api')
  })

  it('allows HTTP only for a loopback development service', () => {
    expect(resolveCollaborationOrigin('http://127.0.0.1:3100/')).toBe('http://127.0.0.1:3100')
    expect(() => resolveCollaborationOrigin('http://example.com')).toThrow('HTTPS')
  })

  it('rejects origins containing credentials or URL state', () => {
    expect(() => resolveCollaborationOrigin('https://user:test@example.com')).toThrow('不能包含')
    expect(() => resolveCollaborationOrigin('https://example.com?token=secret')).toThrow('不能包含')
  })
})
