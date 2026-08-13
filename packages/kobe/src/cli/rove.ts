#!/usr/bin/env bun

import { markRoveInvocation, prepareCliEnvironment } from "./rename-compat.ts"

markRoveInvocation()
prepareCliEnvironment()
await import("./index.ts")
