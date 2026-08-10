using System.Diagnostics;

namespace Pi.CodingAgent.Contained;

/// <summary>
/// Thin launcher for the packaged pi coding agent. The package carries the
/// built JavaScript payload; Node.js itself is expected on the host.
/// </summary>
internal static class Program
{
    private static readonly Version MinimumNodeVersion = new(22, 19, 0);

    private static int Main(string[] args)
    {
        string entryPoint = Path.Combine(
            AppContext.BaseDirectory,
            "payload",
            "node_modules",
            "@earendil-works",
            "pi-coding-agent",
            "dist",
            "cli.js");

        if (!File.Exists(entryPoint))
        {
            Console.Error.WriteLine($"pi-fork: packaged payload is missing (expected {entryPoint}).");
            return 1;
        }

        string node = Environment.GetEnvironmentVariable("PI_NODE") is { Length: > 0 } configuredNode
            ? configuredNode
            : "node";

        if (!TryReadNodeVersion(node, out Version? nodeVersion, out string? failure))
        {
            Console.Error.WriteLine($"pi-fork: {failure}");
            Console.Error.WriteLine(
                "pi-fork: install Node.js 22.19 or newer and make sure it is on PATH, or point PI_NODE at a node executable.");
            return 127;
        }

        if (nodeVersion < MinimumNodeVersion)
        {
            Console.Error.WriteLine(
                $"pi-fork: Node.js {MinimumNodeVersion} or newer is required, but {node} reports {nodeVersion}.");
            return 1;
        }

        var startInfo = new ProcessStartInfo(node) { UseShellExecute = false };
        startInfo.ArgumentList.Add(entryPoint);
        foreach (string arg in args)
        {
            startInfo.ArgumentList.Add(arg);
        }

        using Process? process = Process.Start(startInfo);
        if (process is null)
        {
            Console.Error.WriteLine($"pi-fork: failed to start {node}.");
            return 1;
        }

        // The child shares this console, so it receives Ctrl+C itself. Keep the
        // launcher alive so it can still report the child's exit code.
        Console.CancelKeyPress += (_, eventArgs) => eventArgs.Cancel = true;

        process.WaitForExit();
        return process.ExitCode;
    }

    private static bool TryReadNodeVersion(string node, out Version? version, out string? failure)
    {
        version = null;
        failure = null;

        var startInfo = new ProcessStartInfo(node)
        {
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
        };
        startInfo.ArgumentList.Add("--version");

        string output;
        try
        {
            using Process? process = Process.Start(startInfo);
            if (process is null)
            {
                failure = $"failed to start {node}.";
                return false;
            }

            output = process.StandardOutput.ReadToEnd().Trim();
            process.WaitForExit();

            if (process.ExitCode != 0)
            {
                failure = $"{node} --version exited with code {process.ExitCode}.";
                return false;
            }
        }
        catch (Exception exception)
        {
            failure = $"could not run {node}: {exception.Message}";
            return false;
        }

        // node --version prints e.g. "v22.19.0"; drop any prerelease suffix.
        string trimmed = output.TrimStart('v', 'V').Split('-', '+')[0];
        if (!Version.TryParse(trimmed, out Version? parsed))
        {
            failure = $"could not parse the Node.js version reported by {node}: \"{output}\".";
            return false;
        }

        version = parsed;
        return true;
    }
}
