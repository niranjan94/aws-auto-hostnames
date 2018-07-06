## aws-auto-hostnames

A small tool to update Route53 records with hostnames for instances based on a set tag.

#### Usage

- Set tag `hostnames` on instances with the hostnames desired.
- Ensure you have hosted zones pertains to the base domains
- Override configuration as required via `config.json`
- Then just run this tool
    ```bash
    yarn install
    yarn build
    yarn start
    ```

> This tool can also run as a lambda function and respond to any events that can be set by you.

#### License

```
Copyright 2018 Niranjan Rajendran

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```