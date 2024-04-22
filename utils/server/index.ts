import { Message } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';
import {
  createParser,
  ParsedEvent,
  ReconnectInterval,
} from 'eventsource-parser';
import { OPENAI_API_HOST } from '../app/const';

export class OpenAIError extends Error {
  type: string;
  param: string;
  code: string;

  constructor(message: string, type: string, param: string, code: string) {
    super(message);
    this.name = 'OpenAIError';
    this.type = type;
    this.param = param;
    this.code = code;
  }
}

export const OpenAIStream = async (
  model: OpenAIModel,
  systemPrompt: string,
  key: string,
  messages: Message[],
) => {

  // const res = await fetch(`${OPENAI_API_HOST}/v1/chat/completions`, {
  // APIの向き先をオーケストレーターへ変更する（以下の設定はローカルホストとの疎通を示す例）
  // Azure App Serviceでホスティングした場合：https://{app serviceのリソース名}.azurewebsites.net/v1/chat/completions`;
  const res = await fetch(`http://127.0.0.1:8000/v1/chat/completions`, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key ? key : process.env.OPENAI_API_KEY}`,
      ...(process.env.OPENAI_ORGANIZATION && {
        'OpenAI-Organization': process.env.OPENAI_ORGANIZATION,
      }),
    },

    method: 'POST',
    body: JSON.stringify({
      model: model.id,
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        ...messages,
      ],
      max_tokens: 1000,
      temperature: 1,
      stream: true,
    }),
  });

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  if (res.status !== 200) {
    const result = await res.json();
    if (result.error) {
      throw new OpenAIError(
        result.error.message,
        result.error.type,
        result.error.param,
        result.error.code,
      );
    } else {
      throw new Error(
        `OpenAI API returned an error: ${
          decoder.decode(result?.value) || result.statusText
        }`,
      );
    }
  }

  const stream = new ReadableStream({
    async start(controller) {
      let shouldClose = false; // ストリームを閉じるべきかどうかのフラグ

      const onParse = (event: ParsedEvent | ReconnectInterval) => {
        if (event.type === 'event') {
          const data = event.data;
          console.log(data);

          try {
            if (data.includes('"status": "done"')) {
              console.log('Stream has been signalled to close.');
              shouldClose = true; // ストリームを閉じるフラグを設定
              return; // ここでreturnすると、その後のデータ処理が行われず、ストリームが閉じられる
            }

            const json = JSON.parse(data);
            console.log(json);

            if (Array.isArray(json.choices) && json.choices.length > 0) {
              const choice = json.choices[0];
              const text = choice.delta && choice.delta.content ? choice.delta.content : '';
              const queue = encoder.encode(text);
              controller.enqueue(queue);

              // finish_reasonが'stop'である場合、ストリームを閉じる準備
              if (choice.finish_reason === 'stop') {
                console.log('Received stop signal, will close after processing all data.');
                shouldClose = true; // データ処理が完了次第、ストリームを閉じるようにフラグを設定
              }
            } else {
              // 空のchoicesがある場合の処理が必要な場合はここに記述
            }
          } catch (e) {
            console.error('Error while processing stream data:', e);
            controller.error(e);
          }
        }
      };

      const parser = createParser(onParse);

      try {
        for await (const chunk of res.body as any) {
          parser.feed(decoder.decode(chunk));
        }
      } finally {
        if (shouldClose) {
          console.log('Closing the stream after all data has been processed.');
          controller.close(); // データ処理が完了した後、安全にストリームを閉じる
        }
      }
    },
  });


  return stream;
};