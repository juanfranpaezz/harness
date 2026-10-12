# Windows bootstrap task notes

The frozen plan governs the handoff: only git, node, and python determine
`next` and `deferred`. A declined gh remains `declined` in `items` and causes
exit 3 because it is required, but does not enter `deferred` or suppress `next`
when all three core prerequisites are present or installed. The same rule
applies to Claude Code. This resolves the conflicting task example that put
a declined gh in `deferred`.
