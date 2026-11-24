from tethys_sdk.app_settings import CustomSetting
from tethys_sdk.base import TethysAppBase


class App(TethysAppBase):
    """
    Tethys app class for hydrowf-studio.
    """
    name = 'hydrowf-studio'
    description = 'Build pipelines from registered tools and run them on hydrowf'
    package = 'hydrowf_studio'  # WARNING: Do not change this value
    index = 'home'
    icon = f'{package}/images/icon.png'
    root_url = 'hydrowf-studio'
    color = ''
    tags = 'CIROH, NGIAB'
    enable_feedback = False
    feedback_emails = []

    def custom_settings(self):
        return (
            CustomSetting(
                name="ogc_url",
                type=CustomSetting.TYPE_STRING,
                description="hydrowf-ogc's /ogc, called with each user's Keycloak token",
                required=True,
                default="http://localhost:8000/ogc",
            ),
            CustomSetting(
                name="registry_url",
                type=CustomSetting.TYPE_STRING,
                description="hydrowf-registry, called with each user's Keycloak token",
                required=True,
                default="http://localhost:8002",            # 8001 is /ogc's step-key vendor
            ),
            CustomSetting(
                name="poll_seconds",
                type=CustomSetting.TYPE_INTEGER,
                description="Seconds between two looks at a running job's steps, in the browser",
                required=True,
                default="10",
            ),
        )
