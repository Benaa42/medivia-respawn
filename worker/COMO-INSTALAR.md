# Ponte com a API do Medivia (Cloudflare Worker)

O site é estático e não pode guardar senha. Este Worker fica no meio: o site pede os dados a ele, e ele consulta a API oficial do Medivia com a conta do site. A senha fica escondida no painel da Cloudflare, como **segredo**. Ela não aparece no código nem no GitHub, e ninguém além de você a vê.

## Passo a passo (no painel da Cloudflare, na mesma conta do domínio)

1. **Criar o Worker:** Workers & Pages → Create → Create Worker. Nome: `medivia-api`. Clique em Deploy, que publica o exemplo "Hello World".
2. **Colocar o código:** Edit code. Apague tudo, cole o conteúdo de `medivia-api.js` desta pasta e clique em Deploy.
3. **Guardar o login da conta do site:** Settings → Variables and Secrets → Add, uma vez para cada item abaixo. Escolha o tipo **Secret** nos dois:
   - `MEDIVIA_USUARIO`: o número da conta separada, a mesma sequência que você usa para entrar no site do Medivia.
   - `MEDIVIA_SENHA`: a senha dessa conta.

   Clique em Deploy depois de salvar.
4. **Endereço próprio:** Settings → Domains & Routes → Add → Custom Domain → `api.medivialabs.com`. A Cloudflare cria o DNS sozinha. Isso é necessário porque o Worker só guarda as respostas quando roda num domínio próprio.
5. **Testar:** abra `https://api.medivialabs.com/teste`.
   - `"ok": true`: o login funcionou.
   - `"a API recusou o login"`: troque `MEDIVIA_USUARIO` pelo **nome do personagem** dessa conta (o aviso da API fala em nome do personagem), clique em Deploy e teste de novo.

Depois, `https://api.medivialabs.com/player/Bena` deve mostrar a ficha.

## O que ele faz

- Só leitura: player, online, highscores, guilds e houses, os mesmos endereços da API.
- Guarda cada resposta pelo tempo que a própria API indica (`cached_for`: 5 minutos para a ficha, 1 minuto para quem está online, 1 hora para o ranking). Assim não consulta a API demais, como a equipe do jogo pediu.
- Pelo navegador, só libera os dados para o medivialabs.com e para os testes locais.
