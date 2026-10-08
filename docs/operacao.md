# Fluxo Relay — operação e desenvolvimento

## Papel de cada parte

| Parte | Função |
| --- | --- |
| Node.js | Receber chamadas e executar a integração. |
| API | Receber HTTP e confirmar rapidamente as mensagens. |
| Worker | Executar os trabalhos da fila em um processo separado. |
| PostgreSQL | Guardar lotes, itens, tentativas, resultados e respostas do callback. |
| Redis + BullMQ | Organizar trabalhos em fila para processamento em segundo plano. |
| Docker Compose | Subir os serviços com um único comando. |
| React + shadcn/ui | Iniciar execuções e acompanhar itens, logs e indicadores. |
| WebSocket | Atualizar o painel sem precisar recarregar a página. |
| Simulador local | Reproduzir a plataforma sem chamar o backend da empresa. |

RabbitMQ não é necessário na escolha atual: Redis com BullMQ já oferece a fila.
O painel é um complemento para demonstrar e acompanhar o fluxo da integração.

## Executar tudo com Docker

Requisitos: Docker Desktop funcionando com containers Linux e Docker Compose.

Na primeira execução, copie a configuração local:

```powershell
Copy-Item .env.example .env
docker compose up -d --build --wait
```

Não sobrescreva o `.env` caso já tenha configurado valores próprios.

Endereços locais:

- Painel: http://localhost:4000/.
- API: http://localhost:4000/health
- Estado das dependências: http://localhost:4000/ready
- PostgreSQL: `127.0.0.1:5432`.
- Redis: `127.0.0.1:6379`.

Usuário, senha e banco de desenvolvimento estão no `.env`. As portas publicadas
ficam restritas ao computador local. O HTTPS público será configurado na etapa
de integração, expondo somente a API.

Comandos úteis:

```powershell
docker compose ps
docker compose logs -f api
docker compose logs -f worker
docker compose down
```

`docker compose down` preserva os volumes. Não acrescente `-v` se quiser manter os dados.
O Redis usa AOF e `noeviction`, evitando descartar trabalhos para liberar memória.
A persistência AOF padrão ainda admite uma pequena janela de perda em uma queda
abrupta. O publicador reconsulta trabalhos não terminados no PostgreSQL e
reconstrói mensagens ausentes do Redis sem resetar o orçamento de tentativas.

## Desenvolver com atualização automática

Requisito adicional: Node.js 24 e npm.

```powershell
npm ci
npm --prefix web ci
docker compose stop api worker
docker compose up -d --wait postgres redis
npm run dev:api
```

Em outro terminal, na mesma pasta:

```powershell
npm run dev:worker
```

Em mais dois terminais, execute `npm run dev:simulator` e `npm run dev:web`.
O painel de desenvolvimento fica em http://localhost:5173. O Vite encaminha
HTTP e WebSocket para a API local na porta 4000. O simulador no Windows fica
em `127.0.0.1:4300`; não publique esse serviço via ngrok.

Nesse modo, os dois processos Node rodam no Windows e o banco e o Redis continuam no Docker.
Pare os processos antes de voltar ao modo Docker para não disputar a porta da API.
Múltiplos workers podem consumir a mesma fila; o limite de três trabalhos é global.
O worker não publica porta HTTP.
Se mudar portas ou credenciais, atualize também `DATABASE_URL` e `REDIS_URL` no `.env`
para os comandos executados no Windows. A API em Docker usa os endereços internos.

## Validar a configuração

Com os serviços no ar e as dependências npm instaladas:

```powershell
npm run typecheck
npm run build
npm run test:api
npm run test:worker
npm run test:dashboard
npm run build:web
npm run verify
```

A verificação consulta `/ready`, confere o contrato do `/check`, faz uma escrita e
leitura temporárias no PostgreSQL e envia um trabalho ao worker separado via BullMQ.
O worker verifica também sua própria conexão ao banco antes de concluir o trabalho.
`verify` também envia 20 itens fora de ordem e 10 duplicatas por HTTP, confere
que existem apenas 20 itens e 20 tarefas e informa o maior tempo de ACK local.
Somente o lote criado pela própria verificação é removido ao final.
`test:api` usa um schema PostgreSQL temporário com nome aleatório, aplica as
migrations nele e o remove ao final. Dados existentes não são usados como fixtures.
`test:worker` usa outro schema temporário e filas com prefixo aleatório, inicia
uma plataforma HTTP exclusivamente em `127.0.0.1` e executa dois workers juntos.
Testa o lote completo, duplicatas, limite global, retries, falhas permanentes,
callback, recuperação de uma interrupção e reconstrução de mensagens ausentes.
Esses recursos do teste são removidos ao final.
O teste também valida os comandos de status e exportação e salva um exemplo em
`output/test-results/local-simulation.json`. Esse arquivo está identificado como
resposta do simulador e não substitui o relatório da plataforma real na entrega.
Ela não chama o backend da empresa nem altera lotes reais. Um teste local não
comprova o SLA de 600 ms pela internet; isso foi medido na execução real incluída no repositório.

## Usar o painel

Abra http://localhost:4000 e clique em **Novo teste**. Escolha o fluxo
feliz ou o cenário com falhas temporárias. A API recebe 20 itens fora de ordem e
três duplicatas; o worker consulta o simulador, processa os itens e envia o callback.
Tudo passa pelos componentes reais do projeto, usando dados de simulação.

- **Testes:** histórico das 50 execuções mais recentes, com nomes fixos como
  Teste 1, início, término, duração, lote e itens processados. Abrir um teste
  mostra três quadros: **Recebidos** (vermelho), **Processando** (amarelo) e
  **Processados e enviados** (verde). Os itens mudam de quadro conforme o estado
  confirmado no banco, atualizado pelo WebSocket. O verde exige callback aceito;
  enriquecimento pronto, espera de retry e espera do envio ficam no amarelo.
  Falhas definitivas ficam no vermelho, identificadas como falha. Clique no item
  para ver horários, tentativas, campos do JSON recebido em `/process` e resultado.
  O JSON vem da primeira mensagem preservada na outbox; apenas `run_id`, `seq` e
  `sku` são expostos, evitando mostrar campos extras ou credenciais. Mensagens
  sem esse registro são explicitamente identificadas como reconstituídas.
  Há uma visualização **Tabela**, com filtro por status, e resultado para baixar.
  Em **Ver tempos**, cada item mostra início, término e tempo da última consulta concluída
  ao backend (identificado como simulador local nas simulações). A duração começa na
  primeira tentativa do worker, exclui a fila inicial e inclui a espera entre novas
  tentativas; continua atualizando até o item terminar. O tempo da consulta mede a
  chamada HTTP e a leitura/validação da resposta, não apenas o trabalho interno do backend.
- **Logs:** últimos 200 eventos, busca, filtro por nível, pausa da visualização e exportação.
- **Integração:** cadastro do webhook e solicitação de lote real, bloqueados por padrão.

Cada início corresponde a um teste com um lote; essa é a unidade de execução
do contrato atual. A numeração é persistida no banco e não muda ao recarregar
a página. Mensagens sem metadados de execução ainda não recebem um número.
O término com sucesso é registrado quando o callback é confirmado. Com falhas
definitivas em itens, o término aguarda os demais itens chegarem ao estado final;
falha definitiva no callback também registra o término. Execuções antigas com
horário de conclusão disponível são preservadas na migration.

Os gráficos e indicadores técnicos foram retirados da tela principal para
priorizar o histórico. As medições continuam disponíveis nos snapshots da API.
O filtro na aba Logs seleciona os eventos de um teste. O ACK é medido dentro da API: o primeiro ACK de
cada lote fica fora do cálculo de latência (warmup). Rede, ngrok e a nota oficial
não estão incluídos. Cada amostra é guardada em lotes após a resposta HTTP;
falhas de telemetria não impedem o recebimento e aparecem como amostras perdidas.

Eventos de domínio são gravados por triggers na mesma transação da mudança de
estado. Tentativas de consulta têm horário, duração e status HTTP persistidos.
As consultas do painel usam um pool separado do pool de recebimento. Clientes
WebSocket com o mesmo filtro compartilham uma consulta; a reconexão recebe um
snapshot completo. Há heartbeat, limite de conexões e proteção contra clientes lentos.
O painel é uma ferramenta de demonstração local: retenção de logs e agregações
pré-calculadas devem ser adicionadas para uso contínuo em grande volume.

Para executar a integração real, configure `PROCESSING_ENABLED=true`
e uma `DASHBOARD_TOKEN` hexadecimal aleatória de 32 a 128 caracteres, reinicie
API e worker e informe essa chave no painel. Os controles reais exigem ambas as
configurações. A sessão usa cookie HttpOnly/SameSite e os endpoints do painel
verificam a origem. O token recebido da plataforma nunca é enviado ao frontend.
`SIMULATION_ENABLED=false` desliga as simulações. Em Docker, o simulador não tem
porta publicada. O painel completo também é servido pela API; proteja o acesso
com `DASHBOARD_TOKEN`. Para o webhook público, use o gateway na porta 4100.

`test:dashboard` usa schema temporário e valida WebSocket, reconexão, métricas,
warmup, logs, proteção dos controles, ausência de tokens e separação de lotes locais.

## Arquivos principais

- `compose.yaml`: serviços, portas, volumes e verificações de saúde.
- `src/webhook/`: gateway da porta 4100 que expõe somente o contrato público.
- `.env.example`: modelo das configurações locais.
- `src/api/main.ts`: inicia e encerra a API.
- `src/api/app.ts`: monta a aplicação HTTP.
- `src/api/routes/health.routes.ts`: estado da API e de suas conexões.
- `src/api/modules/integration/check.route.ts`: validação do webhook.
- `src/api/modules/processing/process.route.ts`: validação e resposta do `/process`.
- `src/api/modules/processing/receive-item.ts`: operação de recebimento.
- `src/api/modules/processing/item.repository.ts`: gravação e deduplicação na mesma transação.
- `src/api/modules/integration/platform-client.ts`: chamadas de registro e solicitação de lote.
- `src/api/modules/integration/integration.service.ts`: coordenação do cadastro e da solicitação.
- `src/api/modules/integration/integration.repository.ts`: credenciais da integração no banco.
- `src/api/modules/batches/batch.repository.ts`: identificação e total esperado de cada lote.
- `src/api/modules/dashboard/`: endpoints do painel, WebSocket, snapshots e amostras de ACK.
- `src/simulator/main.ts`: plataforma HTTP exclusivamente local.
- `web/src/pages/`: uma tela por aba do painel.
- `web/src/components/ui/`: componentes shadcn/ui.
- `web/src/hooks/use-dashboard.ts`: conexão e reconexão do WebSocket.
- `web/src/lib/`: cliente HTTP, exportação e formatação.
- `src/worker/main.ts`: inicia e encerra o worker e atualiza seu estado de saúde.
- `src/worker/healthcheck.ts`: verificação do worker executada pelo Docker.
- `src/worker/processors/probe.processor.ts`: processamento do trabalho de diagnóstico.
- `src/worker/runtime.ts`: filas, consumidores, limite global e ciclo de publicação.
- `src/worker/publishers/outbox.publisher.ts`: publicação e reconciliação dos trabalhos pendentes.
- `src/worker/processors/product.processor.ts`: consulta e gravação do resultado de um item.
- `src/worker/processors/callback.processor.ts`: consolidação e envio do lote completo.
- `src/worker/integration/platform-client.ts`: HTTP de enriquecimento e callback.
- `src/worker/repositories/`: dados e exclusão mútua usados pelo processamento.
- `src/worker/retry.ts`: limite de tentativas, backoff e respeito ao retry-after.
- `src/shared/infra/`: conexões com PostgreSQL e Redis.
- `src/shared/contracts/queues.ts`: nome da fila e tipos das mensagens.
- `src/shared/config/env.ts`: configurações compartilhadas.
- `src/shared/contracts/processing.ts`: mensagem do webhook e do trabalho pendente.
- `src/shared/contracts/platform.ts`: respostas de registro e solicitação de lote.
- `src/shared/infra/migrate.ts`: execução transacional das migrations.
- `migrations/001_api_receiving.sql`: tabelas de integração, lote, item e outbox.
- `migrations/002_worker_processing.sql`: estado do processamento e histórico de callbacks.
- `migrations/003_dashboard.sql`: origem do lote, eventos e medições do painel.
- `migrations/004_test_history.sql`: numeração fixa e horários do histórico de testes.
- `scripts/register.ts` e `scripts/burst.ts`: comandos de operação da integração.
- `scripts/migrate.ts`: comando para atualizar o banco manualmente.
- `scripts/status.ts`: consulta do progresso e dos erros de um lote.
- `scripts/report.ts`: exportação da resposta de um callback aceito.
- `scripts/verify.ts`: verificação funcional da infraestrutura.
- `Dockerfile`: compilação e execução da API no Docker.

## Arquitetura escolhida

Um repositório e uma imagem Docker, com dois pontos de entrada:
API e worker. O Compose inicia containers independentes usando a mesma imagem.
Parar o worker não para a API; as mensagens na fila podem aguardar sua volta.

As funcionalidades da API ficam em `src/api`; as do worker, em `src/worker`.
Configurações, conexões e contratos usados pelos dois ficam em `src/shared`.
A API e o worker não importam código um do outro: a comunicação acontece pela
fila e pelos dados persistidos. `shared` não importa nada da API nem do worker.
Compartilhar o código de conexão não compartilha o objeto de conexão entre
processos: cada um mantém suas próprias conexões ao banco e Redis.
Novos módulos serão criados dentro da aplicação responsável pela funcionalidade.

```text
src/
  api/
    main.ts
    app.ts
    routes/
      health.routes.ts
    modules/
      integration/
        check.route.ts
        platform-client.ts
        integration.service.ts
        integration.repository.ts
      processing/
        process.route.ts
        receive-item.ts
        item.repository.ts
      batches/
        batch.repository.ts
      dashboard/
        dashboard.routes.ts
        dashboard.repository.ts
        ack-recorder.ts
    errors.ts
  worker/
    main.ts
    healthcheck.ts
    runtime.ts
    retry.ts
    processors/
      probe.processor.ts
      product.processor.ts
      callback.processor.ts
    publishers/
      outbox.publisher.ts
    integration/
      platform-client.ts
    repositories/
      work.repository.ts
      delivery.repository.ts
  shared/
    config/
      env.ts
    infra/
      database.ts
      redis.ts
      migrate.ts
    contracts/
      queues.ts
      processing.ts
      platform.ts
      dashboard.ts
  simulator/
    main.ts
web/
  src/
    App.tsx
    pages/
      overview.tsx
      batches.tsx
      logs.tsx
      integration.tsx
    components/
      ui/
    hooks/
      use-dashboard.ts
    lib/
      api.ts
      format.ts
```

Rotas e recebimento HTTP entram em `api`; consultas dos produtos, retries e
envio do resultado entram em `worker`. Somente código realmente comum vai
para `shared`, como contratos da fila e acesso à persistência.

O PostgreSQL será a fonte dos dados de lotes e resultados; o Redis organiza a fila.
A gravação do item e do trabalho pendente acontece na mesma transação.
A outbox preserva o trabalho após uma queda antes da publicação. O publicador
usa uma identidade estável por item e tentativa e revisita trabalhos não terminados,
inclusive os anteriormente publicados. Mensagens podem ser repetidas, mas o banco
impede duplicatas no recebimento e o worker ignora itens já concluídos.

## Processamento e recuperação

1. API grava item e outbox e confirma o recebimento.
2. Publicador aguarda `cid` e total esperado, depois publica na fila de produtos.
3. Worker consulta `/enrich/:sku` com `x-cid` e `x-token`.
4. Resultado é validado e guardado; duplicatas concluídas não repetem a consulta.
5. Quando todos os itens esperados estão concluídos, um trabalho de callback é criado.
6. Worker envia a lista completa ordenada por `seq` e guarda a resposta recebida.

O limite global do BullMQ restringe todos os workers da mesma fila a três trabalhos
de enriquecimento. Cada trabalho faz uma consulta por vez. O limite é reaplicado
antes das publicações, inclusive se a configuração do Redis tiver sido perdida.

As tentativas são controladas no PostgreSQL: cada chamada tem seu orçamento
persistido e um horário para a próxima tentativa. A fila executa cada tentativa;
não há uma segunda política de retry competindo com o banco. Padrão: oito
tentativas no total, incluindo a primeira chamada. As esperas usam Fibonacci
(500, 500, 1000, 1500, 2500, 4000, 6500 ms), jitter de até 20% e respeito ao `retry-after`
(segundos ou data HTTP). A espera acontece fora do consumidor e libera a vaga.
Erros 401, 404 e outros erros permanentes encerram o trabalho; 429, 408,
falhas 5xx e problemas de conexão podem ser repetidos.
O teto do backoff com jitter é de 30 segundos; uma espera maior solicitada por
`Retry-After` prevalece. `RETRY_MAX_ATTEMPTS` (1–20), `RETRY_BASE_DELAY_MS` e
`RETRY_MAX_DELAY_MS` configuram a política, validada antes da inicialização.
Fibonacci cresce mais lentamente que a espera exponencial: é uma escolha para
falhas breves desta integração, não uma garantia de maior robustez em todo serviço.
No painel, **Ver tempos** mostra cada tentativa, início, término, duração e status
HTTP; itens aguardando repetição mostram o horário da próxima tentativa.

Locks consultivos do PostgreSQL impedem dois processadores de consultar o mesmo
item ou enviar o mesmo lote simultaneamente. Não mantemos locks de linha durante
a chamada HTTP, permitindo que a API confirme duplicatas enquanto o item é consultado.
Cada chamada tem timeout de cinco segundos. Trabalhos interrompidos podem ser
retomados após 15 segundos; tentativas anteriores continuam contabilizadas.
Uma interrupção pode gastar uma tentativa antes de efetivamente fazer a chamada.

Um item com falha definitiva impede o envio de um lote incompleto. O comando de
status mostra o item, o número de tentativas e a última falha para diagnóstico.
Não há reprocessamento manual automático de falhas definitivas nesta versão.

Se o callback for aceito e a resposta se perder, uma nova tentativa pode gerar
outro relatório. O contrato permite repetir o callback, mas não fornece uma chave
para evitar esse efeito; não prometemos um único envio sob falhas de comunicação.
O histórico guarda cada tentativa, sua lista enviada, status HTTP, erro e resposta.
Respostas em JSON, texto ou sem corpo são preservadas sem presumir um formato de relatório.

## Contrato de recebimento

```http
POST /process
Content-Type: application/json

{"run_id":"lote-abc","seq":7,"sku":"sku-001"}
```

- `202 {"ok":true}`: item e tarefa pendente guardados; vale também para duplicatas.
- `400`: mensagem inválida (campos faltando, tipos incorretos ou sequência negativa).
- `409`: o mesmo `run_id + seq` foi enviado com outro SKU; o original é preservado.
- `503`: não foi possível guardar o trabalho; nenhum ACK de sucesso é enviado.

Não usamos o SKU como identidade: posições ou lotes diferentes podem usar o
mesmo SKU. A chave primária composta no PostgreSQL protege inclusive contra
mensagens iguais que chegam simultaneamente. O total de entregas fica registrado
separadamente da quantidade de itens únicos.

Não exigimos token em `/process`: o contrato não especificam credencial nessa
mensagem. O handshake `/check` devolve o token recebido, sem depender de um
cadastro já salvo.

Uma mensagem pode chegar antes de o comando de lote guardar seus metadados.
A API cria esse lote sem `cid` ou total conhecido e depois o comando completa
esses campos, preservando os itens recebidos. O worker aguarda os
metadados necessários antes de enriquecer ou finalizar o lote.

## Cadastrar e solicitar um lote

Com a API funcionando, exponha o gateway na porta **4100** usando uma ferramenta
de túnel HTTPS. Esse serviço encaminha somente POST `/check` e `/process` para a API;
painel, WebSocket e operações administrativas ficam fora do túnel. Ative
`PROCESSING_ENABLED=true`, configure `DASHBOARD_TOKEN` e reinicie API e worker.
O executável e a conta ngrok precisam ser configurados caso escolha ngrok.

```powershell
ngrok http 4100
npm run integration:register -- --name "Seu Nome" --webhook "https://seu-endereco.ngrok.app"
```

Alternativa para teste sem conta: `npm run integration:tunnel` inicia um Quick
Tunnel da Cloudflare pelo Docker. Consulte `docker compose logs tunnel` para
obter a URL HTTPS e use-a no cadastro. O endereço é temporário e muda ao
reiniciar o túnel; um endereço novo exige novo cadastro. O comando
`npm run integration:tunnel:stop` fecha o acesso público. A configuração do
ngrok continua sendo uma opção para um endereço estável.

A plataforma chama `/check` durante o cadastro. O comando guarda `cid` e `token`
no PostgreSQL e imprime somente a identificação e a URL. Não há uma rota pública
administrativa para cadastrar integrações ou revelar as credenciais.

Para solicitar um lote externo, configure no `.env`:

```dotenv
PROCESSING_ENABLED=true
```

Recrie o worker com `docker compose up -d --build --wait worker` e só então solicite um lote:

```powershell
npm run integration:burst
```

O comando usa a integração cadastrada mais recentemente. Para selecionar outra:

```powershell
npm run integration:burst -- --cid "identificacao-da-integracao"
```

Cada chamada a `/burst` cria outra execução, portanto não há retry automático
desse comando. Enquanto `PROCESSING_ENABLED=false`, mensagens seriam recebidas
e guardadas, mas não seriam enriquecidas nem devolvidas por callback.

## Acompanhar e exportar

Os comandos abaixo só consultam o banco local, sem chamar a plataforma:

```powershell
npm run integration:status -- --run-id "identificacao-do-lote"
npm run integration:report -- --run-id "identificacao-do-lote"
```

O status mostra itens recebidos, concluídos, pendentes, falhas e estado do callback.
A exportação salva a última resposta de callback aceito e os resultados enviados
em `output/reports/`. Para escolher uma tentativa específica:

```powershell
npm run integration:report -- --run-id "identificacao-do-lote" --attempt 2
```

A escolha do melhor relatório depende das métricas que a plataforma realmente
retornar; o comando não inventa métricas nem classifica respostas automaticamente.

`PLATFORM_BASE_URL` no `.env` pode substituir o endereço padrão do contrato.
Para aplicar migrations sem iniciar a API:

```powershell
npm run db:migrate
```

Migrations aplicadas não devem ser editadas: o runner verifica seus checksums.
Mudanças de schema entram em novos arquivos numerados.

## Decisões, limitações e escala

API e worker ficam no mesmo repositório, em processos separados, para distinguir
recebimento de processamento sem acrescentar vários serviços independentes.
PostgreSQL é a fonte dos dados duráveis; BullMQ com Redis organiza a execução.
Escolhemos outbox e deduplicação para tratar a falha entre guardar e publicar.
As migrations podem ser executadas por ambos os processos com exclusão mútua.

Aceitamos o custo de uma gravação no banco antes do ACK e de polling a cada 250 ms
para simplificar recuperação e retries. O limite de tentativas é finito e as falhas
definitivas exigem diagnóstico. Uma consulta pode ser repetida se o processo cair
antes de salvar seu resultado, mas há somente um resultado por `run_id + seq`.

Com 20.000 SKUs, manteríamos o limite contratado de três consultas e estudaríamos
publicação em lotes, índices de reconciliação, paginação dos diagnósticos e métricas
de fila, idade das pendências e tempo de ACK. Mais workers não aumentam o limite
permitido pela plataforma. A 600 ms por consulta, o enriquecimento de 20.000 itens
levaria aproximadamente 67 minutos antes de retries e outros custos.
Para aumentar essa capacidade ou dividir o callback, seria necessário negociar
o contrato com a plataforma. A lista de resultados continua sendo enviada inteira
na implementação atual, conforme o contrato.

Referências usadas na configuração:

- [Conexões do BullMQ](https://docs.bullmq.io/guide/connections).
- [Configuração do Redis para BullMQ](https://docs.bullmq.io/guide/going-to-production).
- [Imagem oficial do PostgreSQL](https://hub.docker.com/_/postgres).
- [Transações com node-postgres](https://node-postgres.com/features/transactions).
- [INSERT e ON CONFLICT no PostgreSQL](https://www.postgresql.org/docs/18/sql-insert.html).
- [Concorrência global do BullMQ](https://docs.bullmq.io/guide/queues/global-concurrency).
