export type CanvasProbeTick = number

declare module 'claude-code' {
  interface PluginState {
    'canvas-probe': { tick: number; presses: number }
  }
}
