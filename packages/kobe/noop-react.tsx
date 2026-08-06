import React, { useEffect, useState } from "react"
// React 19 + react-reconciler with a NO-OP host: isolates React/Bun from opentui.
import ReactReconciler from "react-reconciler"
import { ConcurrentRoot } from "react-reconciler/constants"

const noop = () => {}
const host: any = {
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  supportsMicrotasks: true,
  scheduleMicrotask: queueMicrotask,
  createInstance: (type: string) => ({ type, children: [] as any[] }),
  createTextInstance: (text: string) => ({ text }),
  appendInitialChild: (p: any, c: any) => p.children.push(c),
  appendChild: (p: any, c: any) => p.children.push(c),
  appendChildToContainer: (p: any, c: any) => p.children.push(c),
  insertBefore: noop,
  insertInContainerBefore: noop,
  removeChild: noop,
  removeChildFromContainer: noop,
  finalizeInitialChildren: () => false,
  prepareForCommit: () => null,
  resetAfterCommit: noop,
  commitUpdate: noop,
  commitTextUpdate: noop,
  commitMount: noop,
  clearContainer: noop,
  getRootHostContext: () => ({}),
  getChildHostContext: (p: any) => p,
  getPublicInstance: (i: any) => i,
  shouldSetTextContent: () => false,
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: -1,
  isPrimaryRenderer: true,
  getCurrentUpdatePriority: () => 0b0000000000000000000000000010000,
  setCurrentUpdatePriority: noop,
  resolveUpdatePriority: () => 0b0000000000000000000000000010000,
  maySuspendCommit: () => false,
  maySuspendCommitOnUpdate: () => false,
  maySuspendCommitInSyncRender: () => false,
  preloadInstance: () => true,
  startSuspendingCommit: noop,
  suspendInstance: noop,
  waitForCommitToBeReady: () => null,
  NotPendingTransition: null,
  HostTransitionContext: React.createContext(null),
  resetFormInstance: noop,
  bindToConsole: (m: any) => m,
  shouldAttemptEagerTransition: () => false,
  requestPostPaintCallback: noop,
  detachDeletedInstance: noop,
}
const reconciler = ReactReconciler(host)
function App() {
  const [n, setN] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setN((x) => x + 1), 4)
    return () => clearInterval(t)
  }, [])
  return React.createElement("box", null, React.createElement("text", { content: `row ${n}` }))
}
Bun.write("/tmp/noop.pid", String(process.pid))
const container = reconciler.createContainer(
  { children: [] },
  ConcurrentRoot,
  null,
  false,
  null,
  "",
  console.error,
  console.error,
  console.error,
  () => {},
)
reconciler.updateContainer(React.createElement(App), container, null, () => {})
