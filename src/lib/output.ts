import * as p from '@clack/prompts'

import {DoomainError, type DoomainErrorCode, toDoomainError} from './errors.js'

export interface JsonSuccess<T> {
  ok: true
  data: T
}

export interface JsonFailure {
  ok: false
  error: {
    code: DoomainErrorCode
    message: string
    details?: unknown
  }
}

export type JsonEnvelope<T> = JsonSuccess<T> | JsonFailure

export interface OutputContext {
  readonly json: boolean
  info(message: string): void
  success(message: string): void
  warn(message: string): void
  error(message: string): void
  intro(message: string): void
  outro(message: string): void
  spinner(): {
    error(message?: string): void
    message(message?: string): void
    start(message: string): void
    stop(message?: string): void
  }
  result<T>(data: T): void
}

const noop = () => {}

export function shouldUseJson(flag?: boolean): boolean {
  return Boolean(flag) || !process.stdout.isTTY
}

export function writeJson<T>(data: JsonEnvelope<T>): void {
  process.stdout.write(`${JSON.stringify(data)}\n`)
}

export function createOutput(opts: {json?: boolean} = {}): OutputContext {
  const json = shouldUseJson(opts.json)

  if (json) {
    return {
      json: true,
      info: noop,
      success: noop,
      warn: noop,
      error: noop,
      intro: noop,
      outro: noop,
      spinner: () => ({error: noop, message: noop, start: noop, stop: noop}),
      result: <T>(data: T) => writeJson({ok: true, data}),
    }
  }

  return {
    json: false,
    info: (message) => p.log.info(message),
    success: (message) => p.log.success(message),
    warn: (message) => p.log.warning(message),
    error: (message) => p.log.error(message),
    intro: (message) => p.intro(message),
    outro: (message) => p.outro(message),
    spinner: () => p.spinner(),
    result: noop,
  }
}

export function outputError(json: boolean, error: unknown, fallbackCode: DoomainErrorCode): void {
  const doomainError = error instanceof DoomainError ? error : toDoomainError(error, fallbackCode)

  if (json) {
    writeJson({
      ok: false,
      error: {
        code: doomainError.code,
        message: doomainError.message,
        ...(doomainError.details === undefined ? {} : {details: doomainError.details}),
      },
    })
    return
  }

  p.log.error(doomainError.message)
}
