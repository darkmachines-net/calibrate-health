/** @file Jest shim that supplies Node's process environment to Expo's virtual environment import. */

module.exports = {
    env: process.env
};
