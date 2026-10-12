# QQ Agent server package

The server artifact contains the current checkout's Node core, UI, production
dependencies, maintenance tools and provenance manifest. It does not contain
Electron, SnowLuma, Linux QQ, bundled skills/plugins, user data, login state or
keys. Use Node.js 22.16 or newer; the tested baseline is 22.17.1.

As root, run `install-server.sh ARCHIVE [INSTALL_ROOT] [DATA_DIR] [USER]`.
The installer creates `/etc/qq-agent/server.env`, keeps data in the requested
directory, and enables only `qq-agent-server.service`. It never stops QQ or
SnowLuma. Configure those as the optional separate units after preserving the
existing login data and exact paths. The SnowLuma unit has a narrowly scoped
ambient `CAP_SYS_PTRACE`; no global ptrace sysctl change is made.

`rollback-server.sh` switches the core release symlink only. It never deletes
data. Message database migration/rollback is a separate, offline operation:
`node scripts/message-storage.mjs migrate|export|rollback --data-dir ABS`.
