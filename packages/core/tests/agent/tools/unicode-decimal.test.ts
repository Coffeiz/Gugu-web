import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { asciiDecimalDigits, decimalDigitPattern, isDecimalDigits, isDigitString } from '../../../src/shared/unicode-decimal.js'

describe('Python16固定数字边界', () => {
  it('所有Unicode标量的转换与两类数字判定符合独立Python oracle', () => {
    const hash = createHash('sha256'), singleDigit = new RegExp(`^${decimalDigitPattern}$`, 'u')
    const mismatches: number[] = []
    let decimals = 0, digits = 0
    for (let codepoint = 0; codepoint <= 0x10ffff; codepoint++) {
      if (codepoint >= 0xd800 && codepoint <= 0xdfff) continue
      const character = String.fromCodePoint(codepoint), decimal = isDecimalDigits(character), digit = isDigitString(character)
      if (decimal) decimals++
      if (digit) digits++
      if (singleDigit.test(character) !== decimal && mismatches.length < 20) mismatches.push(codepoint)
      hash.update(codepoint.toString(16) + ':' + asciiDecimalDigits(character) + '\n' + Number(decimal) + '\n' + Number(digit) + '\n')
    }
    expect(hash.digest('hex')).toBe('7a554f0f00de24e12a9f5ec782f2886010c75ec9db67b4e30c668f13af788570')
    expect({ decimals, digits, mismatches }).toEqual({ decimals: 760, digits: 888, mismatches: [] })
  }, 15_000)
  it('整段判定不授予符号或空白兼容，代理字符和新数字原样交给调用方拒绝', () => {
    expect(isDecimalDigits('1٢𝟛')).toBe(true)
    expect(asciiDecimalDigits('1٢𝟛')).toBe('123')
    for (const value of ['', '+1', '-1', '#1', ' 1', '1\n', '\ud800', '\udfff', String.fromCodePoint(0x11de1)]) {
      expect(isDecimalDigits(value)).toBe(false)
      expect(isDigitString(value)).toBe(false)
    }
    expect(isDigitString('1²①')).toBe(true)
    expect(isDecimalDigits('1²①')).toBe(false)
    const untouched = '\ud800²' + String.fromCodePoint(0x11de1) + '\udfff'
    expect(asciiDecimalDigits(untouched)).toBe(untouched)
  })
})
