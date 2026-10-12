# Reads one generic credential from the Windows credential store and prints it as Base64 of a JSON
# object ({ clientId, clientSecret }), so no character of the secret depends on the console code page.
#
# The service client starts this script (credentials.mjs); nobody runs it by hand. The name of the
# credential comes in the environment variable PUBLISH_POST_CREDENTIAL, never inside the script text.
# Exit code 3 means the store has no such entry; credentials.mjs knows it as CREDENTIAL_NOT_FOUND.
#
# PowerShell has no command that returns the secret of a stored credential, so the Win32 function
# CredRead is declared below in C#. The terminator of the here-string ('@) has to stay at the start
# of its line.

$ErrorActionPreference = 'Stop'
Add-Type -Namespace Gi -Name Cred -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct CREDENTIAL {
  public int Flags; public int Type; public string TargetName; public string Comment;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
  public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
}
[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
[DllImport("advapi32.dll")]
public static extern void CredFree(IntPtr cred);
'@
$ptr = [IntPtr]::Zero
if (-not [Gi.Cred]::CredRead($env:PUBLISH_POST_CREDENTIAL, 1, 0, [ref]$ptr)) { exit 3 }
try {
  $c = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][Gi.Cred+CREDENTIAL])
  $secret = [Runtime.InteropServices.Marshal]::PtrToStringUni($c.CredentialBlob, $c.CredentialBlobSize / 2)
  $json = ConvertTo-Json -Compress @{ clientId = [string]$c.UserName; clientSecret = [string]$secret }
  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))
} finally {
  [Gi.Cred]::CredFree($ptr)
}
