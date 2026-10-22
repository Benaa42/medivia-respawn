# Ponte com a API do Medivia (Cloudflare Worker)

O site é estático e não pode guardar senha. Este Worker fica no meio: o site pede os dados a ele, e ele consulta a API oficial do Medivia com a conta do site. A senha fica escondida no painel da Cloudflare, como **segredo**. Ela não aparece no código nem no GitHub, e ninguém além de você a vê.

No ar desde 21/10/2026 em `https://api.medivialabs.com`. O endereço foi ligado pelo próprio domínio, com um registro AAAA `api` apontando para `100::` (nuvem laranja) e uma Workers Route `api.medivialabs.com/*`.

## Atualizar o código

Workers & Pages → `medivia-api` → **Edit code** → apague tudo, cole o conteúdo de `medivia-api.js` desta pasta → **Deploy**.

## Ligar a coleta (histórico de XP e tempo online)

1. **Criar o banco:** no menu da esquerda, **Storage & databases → D1 SQL database → Create**. Nome: `medivia-labs`. Pode deixar a localização automática.
2. **Ligar o banco ao Worker:** em `medivia-api` → **Settings → Bindings → Add binding → D1 database**.
   - **Variable name:** `DB`, exatamente assim, em maiúsculas.
   - **D1 database:** `medivia-labs`.
   - Salve e clique em Deploy, se o painel pedir.
3. **Agendar a coleta:** em `medivia-api` → **Settings → Trigger events → Add → Cron trigger**.
   - Escolha **a cada minuto**. A expressão é `* * * * *`.
   - Salve.
4. **Conferir:** abra `https://api.medivialabs.com/teste`. Deve aparecer `"coleta":"banco ligado"`.

As tabelas são criadas sozinhas na primeira execução; não é preciso rodar nada no banco.

Para coletar outros mundos além de Pendulum, adicione em **Variables and Secrets** uma variável comum (tipo **Text**) `MUNDOS` com os nomes separados por vírgula, por exemplo `pendulum,legacy`.

## O que ele faz

- Só leitura: player, online, highscores, guilds e houses, os mesmos endereços da API, e `/historico/{nome}` com o XP e o tempo online por dia, no horário de Brasília.
- Guarda cada resposta pelo tempo que a própria API indica (`cached_for`: 5 minutos para a ficha, 1 minuto para quem está online, 1 hora para o ranking). Assim não consulta a API demais, como a equipe do jogo pediu. Se a API recusar por excesso de pedidos, devolve a última resposta guardada, de até um dia.
- **Coleta, a cada minuto:**
  - lê quem está online e guarda as sessões, para o tempo online por dia;
  - quando um personagem **acompanhado** desloga, guarda o XP exato dele (no máximo 3 fichas por minuto). Acompanhado é quem já foi aberto no Medivia Labs;
  - nos minutos 10 a 19 de cada hora, lê uma página do ranking de nível por minuto e guarda o XP dos 1000 primeiros, só quando mudou.
- Pelo navegador, só libera os dados para o medivialabs.com e para os testes locais.

## Apoio ao projeto (doações e painel)

Dois segredos a mais no Worker (Settings → Variables and Secrets → Add, tipo **Secret**):

- `PAINEL_CHAVE`: a chave que o painel pessoal usa para ler `/painel/apoio`. O valor fica também no `.env` do painel
  (`%USERPROFILE%\.cache\medivia-visitas\.env`, linha `PAINEL_CHAVE=`), fora do OneDrive. Os dois têm de ser iguais.
- `KOFI_TOKEN`: o código de verificação do Ko-fi. No Ko-fi: Settings → More → API → copie o **Verification Token** para
  o segredo e, no mesmo lugar, ponha `https://api.medivialabs.com/kofi` em **Webhook URL**. O botão de teste do Ko-fi
  manda uma doação de exemplo, que aparece no painel.

O site manda ao Worker, em `/apoio`, só a ação feita na caixa de apoio (abriu, copiou o Pix, abriu o link do banco,
foi ao Ko-fi); o Worker guarda a ação, o dia e o país. Nada de quem foi.
