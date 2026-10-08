# Gera o index.html (para abrir fora do Claude) a partir do page.html.
# O page.html é o conteúdo da página; aqui ele só ganha o esqueleto <html>/<head>/<body>.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$page = Get-Content -Raw -Encoding UTF8 (Join-Path $here 'page.html')
$head = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style></head><body>'
$html = $head + "`n" + $page + "`n</body></html>`n"
[System.IO.File]::WriteAllText((Join-Path $here 'index.html'), $html, (New-Object System.Text.UTF8Encoding($false)))
"index.html gerado"
