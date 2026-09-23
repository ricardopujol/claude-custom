// FF9 Q2 latency comparison point ONLY -- not shipped.
//
// Byte-for-byte copy of helper/hook-helper.cs's pipe-write path, so the
// Windows-process-creation + AOT-runtime-startup floor is identical to the
// shipped helper. The ONLY addition is printing the
// { hookSpecificOutput: { hookEventName, updatedInput } } JSON line to
// stdout after the pipe write, exactly as an FF9 item-rewriting hook would.
//
// The shipped helper deliberately never parses its payload (forwarding it
// verbatim is the whole point of its speed). This variant does not either --
// it writes a fixed, representative updatedInput blob, because what Q2 is
// isolating is the cost of the stdout WRITE itself, not JSON parsing
// performance the shipped helper doesn't pay today and wouldn't need to for
// a fixed rewrite shape.
using System;
using System.IO;
using System.IO.Pipes;
using System.Text;

static class HookHelperUpdatedInput
{
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

            var name = pipe;
            const string prefix = @"\\.\pipe\";
            if (name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                name = name.Substring(prefix.Length);

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
        catch (TimeoutException) { }
        catch (IOException) { }
        catch (Exception) { }

        // The FF9 addition: a fixed, representative updatedInput rewrite,
        // printed to stdout for Claude Code to parse and apply.
        Console.Out.Write("{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"updatedInput\":"
            + "{\"subagent_type\":\"general-purpose\",\"prompt\":\"reply with the single word OK\",\"model\":\"haiku\"}}}");

        return 0;
    }
}
