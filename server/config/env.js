const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

module.exports = async () => {
    const secretManager = new SecretsManagerClient({ region: 'sa-east-1' });
    const data = await secretManager.send(
        new GetSecretValueCommand({ SecretId: 'arn:aws:secretsmanager:sa-east-1:244807945617:secret:env-8tdon8' })
    );
    const secret = JSON.parse(data.SecretString);
    URLDB = secret.URLDB;
    CADUCIDAD_TOKEN = secret.CADUCIDAD_TOKEN;
    SEED = secret.SEED;
    AWS_SES_USER = secret.AWS_SES_KEY_ID;
    AWS_SES_PASS = secret.AWS_SES_ACCESS_KEY;
    SES_CONFIG = JSON.stringify({
        accessKeyId: secret.AWS_SES_KEY_ID,
        secretAccessKey: secret.AWS_SES_ACCESS_KEY,
        region: 'us-east-1',
    });
    let secretsString = "";
    Object.keys(secret).forEach((key) => {
        secretsString += `${key}=${secret[key]}\n`;
    });
    return secretsString;
};
