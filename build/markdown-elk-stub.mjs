// Stands in for elkjs/lib/elk.bundled.js in the Markdown bundle (BACKLOG #119 A9).
//
// Mermaid loads elkjs only for a diagram that asks for `layout: elk`. elkjs is 1.6 MB and EPL-2.0 (weak copyleft),
// where everything else in the bundle is MIT, ISC, BSD, Apache or public domain. Leaving it out costs one thing: a
// diagram that asks for the ELK layout shows its source with "diagram didn't render: ..." under it, like any other
// diagram that can't be drawn. Every default layout (dagre, the sequence, class, state, gantt, pie... diagrams) is
// untouched.
export default class ELK {
  constructor() {
    throw new Error('the ELK layout is not included in this reader');
  }
}
