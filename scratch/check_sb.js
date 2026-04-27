'use strict';

require('dotenv').config();
const { ServiceBusClient } = require('@azure/service-bus');

async function main() {
  const connectionString = process.env.SERVICE_BUS_CONNECTION_STRING;
  const topicName = process.env.DAPR_TOPIC_DYNAMICS || 'sbt-dynamics-events';
  const subscriptionName = 'dynamics-marketo-sync'; // App ID is usually the subscription name in Dapr

  console.log(`Checking Service Bus: ${topicName} / ${subscriptionName}`);

  const sbClient = new ServiceBusClient(connectionString);
  
  try {
    // We can't easily list subscriptions without the Admin client, 
    // but we can try to peek messages if we know the sub name.
    const receiver = sbClient.createReceiver(topicName, subscriptionName);
    
    console.log('Peeking messages...');
    const messages = await receiver.peekMessages(5);
    
    if (messages.length === 0) {
      console.log('No messages found in the subscription.');
    } else {
      console.log(`Found ${messages.length} messages.`);
      messages.forEach((msg, i) => {
        console.log(`\n--- Message ${i+1} ---`);
        console.log('Enqueued Time:', msg.enqueuedTimeUtc);
        console.log('Body:', msg.body);
      });
    }

    await receiver.close();
  } catch (err) {
    console.error('Error:', err.message);
    if (err.message.includes('MessagingEntityNotFoundError')) {
      console.error('\n[CRITICAL] The topic or subscription does not exist in Azure Service Bus!');
      console.error('Since disableEntityManagement is "true" in Dapr config, the app will never receive messages if they aren\'t created manually in Azure.');
    }
  } finally {
    await sbClient.close();
    process.exit(0);
  }
}

main();
