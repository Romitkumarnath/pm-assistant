import json, sys
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request

try:
    creds = Credentials.from_authorized_user_file('token.json')
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
        with open('token.json', 'w') as f:
            f.write(creds.to_json())
        print('Token refreshed successfully')
    elif creds and creds.valid:
        print('Token still valid')
    else:
        print('ERROR: Cannot refresh - no refresh token')
except Exception as e:
    print(f'ERROR: {e}')
