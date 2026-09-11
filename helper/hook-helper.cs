// claude-custom :: native hook helper
//
// Spawned by Claude Code once per matched tool call. Writes a single
// newline-terminated JSON line to the host's named pipe and exits.
//
// Two properties matter more than anything else here, because this runs
// SYNCHRONOUSLY in the critical path of every matched tool call:
//
//   1. Start fast. A Node hook costs 60-100ms of process startup and
//      PowerShell ~200ms, paid on every Task and Bash call.
//   2. NEVER block the tool call. If the host is not listening -- detached,
//      restarting, crashed -- this must give up in milliseconds and exit 0.
//      A mood engine is not worth wedging a session for, so every failure
//      path here is silent and successful.

using System;
using System.IO;
using System.IO.Pipes;
using System.Text;

static class HookHelper
{
    // Generous enough for a running host on a loaded machine, short enough
    // that a missing host is indistinguishable from no hook at all.
    const int ConnectTimeoutMs = 80;

    static int Main(string[] args)
    {
        try
        {
            string pipe = null, evt = null;
            for (int i = 0; i < args.Length - 1; i++)
            {
                if (args[i] == "--pipe") pipe = args[i + 1];
                else if (args[i] == "--event") evt = args[i + 1];
            }
            if (pipe == null || evt == null) return 0;

            // Accept either the full \\.\pipe\NAME form or a bare name.
            var name = pipe;
            const string prefix = @"\\.\pipe\";
            if (name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                name = name.Substring(prefix.Length);

            // Claude Code delivers the hook payload as JSON on stdin. It is
            // forwarded verbatim rather than reparsed: the helper's job is
            // transport, and parsing here would add startup cost for nothing.
            string payload = "";
            try { payload = Console.In.ReadToEnd(); } catch { }
            payload = payload.Trim();
            if (payload.Length == 0) payload = "{}";

            var line = new StringBuilder(payload.Length + 64);
            line.Append("{\"event\":\"").Append(evt).Append("\",\"payload\":").Append(payload).Append("}\n");

            using (var client = new NamedPipeClientStream(".", name, PipeDirection.Out))
            {
                client.Connect(ConnectTimeoutMs);
                var bytes = Encoding.UTF8.GetBytes(line.ToString());
                client.Write(bytes, 0, bytes.Length);
                client.Flush();
            }
        }
        catch (TimeoutException) { /* host not listening -- by design, not an error */ }
        catch (IOException) { /* pipe closed mid-write -- same */ }
        catch (Exception) { /* nothing here is worth failing a tool call over */ }

        return 0;
    }
}
