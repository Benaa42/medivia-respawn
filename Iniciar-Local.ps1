# Abre o Medivia Respawn neste computador, fora do Claude.
# Precisa de um servidor local porque o leitor de imagem não roda em arquivo aberto direto (file://).
$porta = 8765
$pasta = Split-Path -Parent $MyInvocation.MyCommand.Path
Start-Process "http://localhost:$porta/index.html"
python -m http.server $porta --bind 127.0.0.1 --directory $pasta