import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

const VERSION = 'v1'
const PANE = 'canvas'
const tick = atom({ plugin: 'canvas-probe', key: 'tick' } as const, 0)
const presses = atom({ plugin: 'canvas-probe', key: 'presses' } as const, 0)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'canvas', description: 'Open the probe canvas pane' })
    $.clock.every(1000, () => { void update($, tick, n => (n ?? 0) + 1) })
    return next(e)
  })

  on('command.run', { command: 'canvas' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Canvas', focus: true })
    return { text: 'Canvas pane opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const t = await read($, tick)
    const p = await read($, presses)
    return (
      <Box>
        <Text color="cyan">CANVAS-BAND {VERSION} tick={t} presses={p} </Text>
        <Button key="ping" label="Ping" hotkey="p" onPress={async () => {
          await update($, presses, n => (n ?? 0) + 1)
          $.ui.toast('CANVAS-TOAST pressed')
        }} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text, Markdown } = $.ui.resolve(e)
    const t = await read($, tick)
    return (
      <Box flexDirection="column">
        <Text bold>CANVAS-PANE {VERSION} tick={t} surface={e.surface} placement={String(e.props.placement)}</Text>
        <Markdown text={'## CANVAS-MD heading\n\n- a **bold** item\n- [a link](https://example.com)'} />
        <Button key="send" label="Send to session" hotkey="s" onPress={async () => {
          await $.prompt.submit({ text: 'CANVAS-BUTTON-CLICKED: the person pressed Send' })
        }} />
      </Box>
    )
  })
}
