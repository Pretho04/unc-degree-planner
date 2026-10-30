# UNC Degree Planner - local server.
# Serves the web app from .\public and proxies three public UNC sources the
# browser can't reach directly (no CORS):
#   catalog.unc.edu          minor requirement pages
#   catalog.unc.edu/ribbit   course descriptions + requisites
#   reports.unc.edu          Class Search (sections + available seats)
param([int]$Port = $(if ($env:PORT) { [int]$env:PORT } else { 8787 }), [switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Net.Http

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Public = Join-Path $Root 'public'
$CacheDir = Join-Path $Root 'cache'
New-Item -ItemType Directory -Force $CacheDir | Out-Null

$CatalogBase = 'https://catalog.unc.edu'
$ClassSearchUrl = 'https://reports.unc.edu/class-search/'
$CatalogCacheHours = 168   # requirements and prereqs rarely change
$SeatCacheSeconds = 120    # seats change constantly

$handler = [System.Net.Http.HttpClientHandler]::new()
$handler.CookieContainer = [System.Net.CookieContainer]::new()
$handler.AutomaticDecompression = [System.Net.DecompressionMethods]::GZip -bor [System.Net.DecompressionMethods]::Deflate
$client = [System.Net.Http.HttpClient]::new($handler)
$client.Timeout = [TimeSpan]::FromSeconds(30)
$client.DefaultRequestHeaders.UserAgent.ParseAdd('UNC-Minor-Planner/1.0 (personal student tool)')

$script:csrf = $null
$script:meta = $null
$script:metaTime = [datetime]::MinValue
$script:seatCache = @{}

function Get-Text([string]$url) {
    $client.GetStringAsync($url).GetAwaiter().GetResult()
}

function Get-Cached([string]$url, [int]$maxAgeHours) {
    $sha = [Security.Cryptography.SHA1]::Create()
    $key = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($url))).Replace('-', '')
    $file = Join-Path $CacheDir "$key.txt"
    if ((Test-Path $file) -and ((Get-Date) - (Get-Item $file).LastWriteTime).TotalHours -lt $maxAgeHours) {
        return [IO.File]::ReadAllText($file, [Text.Encoding]::UTF8)
    }
    $text = Get-Text $url
    [IO.File]::WriteAllText($file, $text, [Text.Encoding]::UTF8)
    $text
}

function Update-ClassSearch {
    $page = Get-Text $ClassSearchUrl
    $script:csrf = [regex]::Match($page, 'name="csrfmiddlewaretoken" value="([^"]+)"').Groups[1].Value
    $terms = [regex]::Match($page, '<script id="json_terms"[^>]*>(.*?)</script>', 'Singleline').Groups[1].Value
    $subjects = [regex]::Match($page, '<script id="json_subjects"[^>]*>(.*?)</script>', 'Singleline').Groups[1].Value
    if (-not $terms) { $terms = '[]' }
    if (-not $subjects) { $subjects = '[]' }
    $script:meta = "{`"terms`":$terms,`"subjects`":$subjects}"
    $script:metaTime = Get-Date
}

function Get-Meta {
    if (-not $script:meta -or ((Get-Date) - $script:metaTime).TotalHours -gt 6) { Update-ClassSearch }
    $script:meta
}

function Search-Sections([string]$subject, [string]$number, [string]$term) {
    $key = "$subject|$number|$term"
    $hit = $script:seatCache[$key]
    if ($hit -and ((Get-Date) - $hit.Time).TotalSeconds -lt $SeatCacheSeconds) { return $hit.Body }

    if (-not $script:csrf) { Update-ClassSearch }
    $resp = $null
    for ($i = 0; $i -lt 2; $i++) {
        $form = [System.Collections.Generic.Dictionary[string, string]]::new()
        $form['csrfmiddlewaretoken'] = $script:csrf
        $form['term'] = $term
        $form['subject'] = $subject
        $form['catalog_number'] = $number
        $req = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, $ClassSearchUrl)
        $req.Headers.Referrer = [Uri]$ClassSearchUrl
        $req.Content = [System.Net.Http.FormUrlEncodedContent]::new($form)
        $resp = $client.SendAsync($req).GetAwaiter().GetResult()
        $body = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        if ($resp.IsSuccessStatusCode) { break }
        Update-ClassSearch   # token/cookie expired; refresh and retry once
    }
    if (-not $resp.IsSuccessStatusCode) { throw "Class Search returned HTTP $([int]$resp.StatusCode)" }

    # Only the results table matters; drop the rest of the page.
    $s = $body.IndexOf('<table')
    $e = $body.IndexOf('</table>')
    $table = if ($s -ge 0 -and $e -gt $s) { $body.Substring($s, $e - $s + 8) } else { '<table></table>' }
    $script:seatCache[$key] = @{ Time = Get-Date; Body = $table }
    $table
}

function Send($ctx, [int]$code, [string]$type, [string]$body) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($body)
    $ctx.Response.StatusCode = $code
    $ctx.Response.ContentType = "$type; charset=utf-8"
    $ctx.Response.Headers['Cache-Control'] = 'no-store'
    $ctx.Response.ContentLength64 = $bytes.Length
    # HEAD (used by health checks) gets the headers only; writing a body would throw.
    if ($ctx.Request.HttpMethod -ne 'HEAD') { $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length) }
    $ctx.Response.OutputStream.Close()
}

$StaticTypes = @{ '.html' = 'text/html'; '.js' = 'text/javascript'; '.css' = 'text/css'; '.svg' = 'image/svg+xml' }

function Invoke-Route($ctx) {
    $path = $ctx.Request.Url.AbsolutePath
    $q = $ctx.Request.QueryString
    switch -Regex ($path) {
        '^/api/catalog$' {
            $p = [string]$q['path']
            if ($p -notmatch '^/undergraduate/(programs-study|ideas-in-action)/([a-z0-9-]+/)?$' -and $p -notmatch '^/courses/[a-z]{2,5}/$') { return Send $ctx 400 'text/plain' 'Bad catalog path' }
            return Send $ctx 200 'text/html' (Get-Cached ($CatalogBase + $p) $CatalogCacheHours)
        }
        '^/api/course$' {
            $code = ([string]$q['code']).ToUpper()
            if ($code -notmatch '^[A-Z]{2,5} \d{2,3}[A-Z]{0,2}$') { return Send $ctx 400 'text/plain' 'Bad course code' }
            $url = "$CatalogBase/ribbit/index.cgi?page=getcourse.rjs&code=" + [Uri]::EscapeDataString($code)
            return Send $ctx 200 'text/xml' (Get-Cached $url $CatalogCacheHours)
        }
        '^/api/seats$' {
            $subject = ([string]$q['subject']).ToUpper()
            $number = ([string]$q['number']).ToUpper()
            $term = [string]$q['term']
            # An empty number searches the whole subject (one request for every GREK section).
            if ($subject -notmatch '^[A-Z]{2,5}$' -or $number -notmatch '^(\d{2,3}[A-Z]{0,2})?$' -or $term -notmatch '^(\d{4} (Spring|Summer I|Summer II|Fall))?$') {
                return Send $ctx 400 'text/plain' 'Bad seat query'
            }
            return Send $ctx 200 'text/html' (Search-Sections $subject $number $term)
        }
        '^/api/meta$' { return Send $ctx 200 'application/json' (Get-Meta) }
        default {
            $name = if ($path -eq '/') { 'index.html' } else { $path.TrimStart('/') }
            $file = Join-Path $Public $name
            $ext = [IO.Path]::GetExtension($name)
            if ($name -match '^[\w.-]+$' -and $StaticTypes.ContainsKey($ext) -and (Test-Path $file)) {
                return Send $ctx 200 $StaticTypes[$ext] ([IO.File]::ReadAllText($file, [Text.Encoding]::UTF8))
            }
            return Send $ctx 404 'text/plain' 'Not found'
        }
    }
}

# Answer both http://localhost and http://127.0.0.1 (otherwise Windows rejects the IP form with 400 Bad Request).
# Registering 127.0.0.1 may need extra rights on some machines, so fall back to localhost only.
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
try { $listener.Start() }
catch {
    $listener = [System.Net.HttpListener]::new()
    $listener.Prefixes.Add("http://localhost:$Port/")
    $listener.Start()
}
Write-Host "UNC Degree Planner running at http://localhost:$Port/   (Ctrl+C to stop)"
if (-not $NoBrowser) { Start-Process "http://localhost:$Port/" }

try {
    while ($listener.IsListening) {
        $task = $listener.GetContextAsync()
        while (-not $task.AsyncWaitHandle.WaitOne(300)) { }   # polling keeps Ctrl+C responsive
        $ctx = $task.GetAwaiter().GetResult()
        try {
            Invoke-Route $ctx
        } catch {
            $err = $_.Exception
            while ($err.InnerException) { $err = $err.InnerException }
            Write-Host "ERROR $($ctx.Request.Url.PathAndQuery): $($err.Message)" -ForegroundColor Red
            try { Send $ctx 502 'text/plain' $err.Message } catch { }
        }
    }
} finally {
    $listener.Stop()
}
