const { ServiceBusClient } = require("@azure/service-bus");
require('dotenv').config();

async function main() {
    const connectionString = process.env.SERVICE_BUS_CONNECTION_STRING;
    const topicName = process.env.DAPR_TOPIC_DYNAMICS; // sbt-dynamics-events
    const subscriptionName = "dynamics-marketo-sync"; // From our list script

    if (!connectionString || !topicName) {
        console.error("Config missing in .env");
        return;
    }

    const sbClient = new ServiceBusClient(connectionString);
    
    // Create a receiver for the Dead Letter Queue
    const receiver = sbClient.createReceiver(topicName, subscriptionName, { subQueueType: "deadLetter" });
    const sender = sbClient.createSender(topicName);

    try {
        console.log(`Checking DLQ for ${topicName}/${subscriptionName}...`);
        const messages = await receiver.receiveMessages(10, { maxWaitTimeInMs: 5000 });

        if (messages.length === 0) {
            console.log("No messages found in DLQ.");
            return;
        }

        console.log(`Found ${messages.length} messages in DLQ. Moving them back to topic...`);

        for (const dlqMessage of messages) {
            // Clone the message body and properties
            const newMessage = {
                body: dlqMessage.body,
                contentType: dlqMessage.contentType,
                correlationId: dlqMessage.correlationId,
                label: dlqMessage.label,
                messageId: dlqMessage.messageId
            };

            await sender.sendMessages(newMessage);
            await receiver.completeMessage(dlqMessage);
            console.log(`- Reprocessed message: ${dlqMessage.messageId}`);
        }

        console.log("Done! All DLQ messages have been returned to the main topic.");
    } catch (err) {
        console.error("Error recovering messages:", err.message);
    } finally {
        await receiver.close();
        await sender.close();
        await sbClient.close();
    }
}

main();
