// import { Injectable } from '@nestjs/common';
//
// import { ElevenLabsClient } from '../clients/elevenlabs/elevenlabs.client';
//
// @Injectable()
// export class YourService {
//   constructor(private readonly elevenLabsClient: ElevenLabsClient) {}
//
//   async testAgent() {
//     // Send first message (creates new conversation)
//     const response1 = await this.elevenLabsClient.sendMessage('Hello, how are you?');
//
//     console.log('Agent response:', response1.output_text);
//     console.log('Conversation ID:', response1.conversation_id);
//     console.log('Audio URL:', response1.audio_url);
//
//     // Continue the conversation
//     const response2 = await this.elevenLabsClient.sendMessage(
//       'Tell me more',
//       response1.conversation_id,
//     );
//
//     console.log('Agent response 2:', response2.output_text);
//
//     return { response1, response2 };
//   }
//
//   async streamAgent() {
//     const stream = await this.elevenLabsClient.streamMessage('Tell me a story');
//
//     // Handle stream
//     stream.on('data', chunk => {
//       console.log('Received chunk:', chunk.toString());
//     });
//
//     stream.on('end', () => {
//       console.log('Stream ended');
//     });
//
//     return stream;
//   }
// }
