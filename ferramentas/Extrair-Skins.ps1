# Copia as imagens da coluna "Image" das tabelas da wiki para Images\Skins, com o nome do item.
# A wiki bloqueia download automático (verificação "você é humano"), então o script trabalha
# em cima da página salva pelo navegador: Ctrl+S > "Página da Web, completa".
param(
    # .html salvo pelo navegador; sem isso, pega o Serena*.htm* mais recente da pasta Downloads
    [string]$HtmlPath,
    [string]$Destino
)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Destino) { $Destino = Join-Path (Split-Path -Parent $here) 'Images\Skins' }

if (-not $HtmlPath) {
    $achado = Get-ChildItem (Join-Path $env:USERPROFILE 'Downloads') -Filter 'Serena*.htm*' -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $achado) { throw 'Nenhum Serena*.html na pasta Downloads. Salve a página (Ctrl+S > "Página da Web, completa") ou informe -HtmlPath.' }
    $HtmlPath = $achado.FullName
}
$HtmlPath = (Resolve-Path -LiteralPath $HtmlPath).Path
$base = Split-Path -Parent $HtmlPath
$html = Get-Content -Raw -Encoding UTF8 -LiteralPath $HtmlPath
New-Item -ItemType Directory -Force $Destino | Out-Null

$opt = [System.Text.RegularExpressions.RegexOptions]'Singleline, IgnoreCase'
function Limpar([string]$s) { [System.Net.WebUtility]::HtmlDecode(($s -replace '<[^>]+>', '')).Trim() }

$colImagem = -1; $colItem = -1
$copiados = 0; $faltando = @(); $vistos = @{}

# Só as linhas mais internas: as tabelas da wiki ficam dentro de outra tabela (a moldura)
foreach ($tr in [regex]::Matches($html, '<tr\b[^>]*>((?:(?!<tr\b).)*?)</tr>', $opt)) {
    $celulas = [regex]::Matches($tr.Groups[1].Value, '<(t[dh])\b[^>]*>(.*?)</\1>', $opt)
    if ($celulas.Count -eq 0) { continue }

    if ($celulas[0].Groups[1].Value -eq 'th') {
        # Cabeçalho: liga a leitura se a tabela tiver a coluna Image, desliga se não tiver
        $titulos = @($celulas | ForEach-Object { Limpar $_.Groups[2].Value })
        $colImagem = [array]::IndexOf($titulos, 'Image')
        $colItem = [array]::IndexOf($titulos, 'Item')
        if ($colImagem -ge 0 -and $colItem -lt 0) { $colItem = $colImagem + 1 }
        continue
    }
    if ($colImagem -lt 0 -or $celulas.Count -le [Math]::Max($colImagem, $colItem)) { continue }

    $img = [regex]::Match($celulas[$colImagem].Groups[2].Value, '<img\b[^>]*?\ssrc="([^"]+)"', $opt)
    $nome = (Limpar $celulas[$colItem].Groups[2].Value) -replace '^\d+\s*x\s*', ''
    if (-not $img.Success -or -not $nome) { continue }
    if ($vistos.ContainsKey($nome)) { continue }
    $vistos[$nome] = $true

    $src = [System.Net.WebUtility]::HtmlDecode($img.Groups[1].Value)
    if ($src -match '^(https?:)?//|^data:') { $faltando += "$nome (imagem não foi salva junto: $src)"; continue }
    $origem = Join-Path $base ([uri]::UnescapeDataString(($src -replace '[?#].*$', '')))
    if (-not (Test-Path -LiteralPath $origem)) { $faltando += "$nome (arquivo não encontrado: $src)"; continue }

    $arquivo = ($nome -replace '[\\/:*?"<>|]', '_') + [System.IO.Path]::GetExtension($origem)
    Copy-Item -LiteralPath $origem -Destination (Join-Path $Destino $arquivo) -Force
    $copiados++
}

"$copiados imagem(ns) copiada(s) para $Destino"
if ($faltando.Count) {
    "$($faltando.Count) sem imagem:"
    $faltando | ForEach-Object { "  - $_" }
}
