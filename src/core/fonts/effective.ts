/**
 * 把用户的字体选择叠加到版式上。
 *
 * 为什么需要单独这一层：`DesignSpec.theme.fontPair` 受
 * `z.enum(FONT_WHITELIST)` 约束（那是给**模型输出**把关的闸门），
 * 而用户是从本机两百多个字体族里挑的，名字多半不在白名单里。
 * 两者必须分开存 —— 详见 `core/design/spec.ts` 里 `withFontOverride`
 * 和 `core/store/generation.ts` 里 `fontOverride` 的注释。
 *
 * 拿到**干净**的 spec 请直接用 `useGenerationStore((s) => s.spec[type])`；
 * 只有「要显示给人看」或「要导出成文件」的地方才用这个 hook。
 */

import { useMemo } from 'react';
import { withFontOverride, type DesignSpec } from '@/core/design/spec';
import { useGenerationStore } from '@/core/store/generation';
import type { DocType } from '@/core/store/workbench';

/**
 * 当前文档**最终呈现**用的 spec（已叠加字体覆盖）。
 *
 * 用 `useMemo` 而不是在 store 里派生：`withFontOverride` 在没有覆盖时
 * 原样返回同一个对象，有覆盖时才会新建。放进 store 会让每次 set 都
 * 产生新引用，下游 `useMemo(renderDocument, [units, spec])` 就全废了。
 */
export function useEffectiveSpec(type: DocType): DesignSpec | null {
  const spec = useGenerationStore((s) => s.spec[type]);
  const override = useGenerationStore((s) => s.fontOverride[type]);

  return useMemo(() => (spec ? withFontOverride(spec, override) : null), [spec, override]);
}
